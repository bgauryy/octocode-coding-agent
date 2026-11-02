import { type JsonObject, validateToolArguments } from "@octocodeai/octocode-ai";
import { captureToolInvocation } from "../../core/tools/tool-invocation.ts";
import { rewriteFileQuery, type FileInputReplacement } from "../shared/claude-file.ts";
import type { Static } from "typebox";
import type { ExtensionAPI, ExtensionToolContext } from "../../core/features/index.ts";
import type { Permission } from "../permission/ask.ts";
import { stateFolderRefusal } from "../permission/file-access.ts";
import { systemLines } from "../permission/effect.ts";
import { changedOnDisk } from "../../../../common/src/atomic-file.ts";
import { canonicalPath } from "../shared/home/repo.ts";
import { timedTool } from "../shared/render/rows.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { readPaths, resolveToolPath } from "../shared/home.ts";
import type { Checkpoints } from "./checkpoint.ts";
import { readView } from "./coverage.ts";
import { type QueryOutcome, renderFileCall, renderFileResult } from "./render.ts";
import { recordedLocalReads } from "../shared/local-reads.ts";
import { parsePatch } from "../shared/codex-patch/patch.ts";
import { patchChanges, validateFileInput } from "../shared/file-input.ts";
import { askReview } from "./review.ts";
import { bashReads } from "./bash-reads.ts";
import { type FileGuard, returnedContent } from "./tool/guard.ts";
import { inspectQueryBatch, preparePatch } from "./tool/prepare.ts";
import {
	changePurpose,
	type FileQuery,
	type FileReplacementOwner,
	formatOutcomes,
	Params,
	type PreparedChange,
	renameReasoning,
} from "./tool/queries.ts";
import { runQuery } from "./tool/run.ts";
export { projectEditHunk } from "./tool/patch-projection.ts";
import { formatFeedback, inspectMutations } from "./feedback/diagnostics.ts";
import { captureParseBefore, formatParseFeedback, inspectParseAfter } from "./feedback/parse.ts";

/**
 * Octocode's `file` tool: batched edit / write / delete queries, each with a
 * reason line. Edits and writes run through the engines of `tool/apply.ts` (exact replacement with a
 * whitespace/punctuation fallback, diffs, per-file mutation queue) but replace files atomically (temp file + rename) with a content check under a cross-process lock.
 * Writers outside Octocode that do not acquire that lock can still race the check. A file read with Octocode's `localFetch` (or printed by a plain `bash` command, see `bash-reads.ts`), or changed by this
 * tool, that changed on disk since then must be read again before a write or delete; an edit re-validates each oldText
 * against the current content and applies when each still matches exactly once. A file whose earlier read left the
 * context (compaction, a branch switch, a rewind that restored it) must be read again before
 * it is changed, even if the disk did not move.
 *
 * Paths are checked against the workspace first: Octocode's own state folder (the Octocode home, holding trust
 * decisions, memory and sessions) is never changed, and a path outside the repository is a `file.outside` permission
 * ask. In `manual` mode the batch's review dialog is its `file.workspace` ask.
 *
 * A read is recorded by stat (size, mtime, ctime, inode) of the canonical path, without reading the file again; its
 * digest is known only when the read returned the whole file (Octocode's read) or the file tool wrote it, and is then
 * checked against the bytes the change reads anyway. Residual race: a file changed between the read tool reading it
 * and the stat here is taken as read (unless its digest was known from the returned text).
 */

export function registerFileTool(
	api: ExtensionAPI,
	guard: FileGuard,
	permission: Permission,
	checkpoints?: Checkpoints,
	replacementOwner?: FileReplacementOwner,
	feedback?: { enabled: boolean },
): void {
	api.registerTool(
		timedTool(
			{
				name: "file",
				label: "File",
				promptSnippet: "Create, edit, delete or patch files",
				description:
					"Applies a batch of file changes; it does not read files. Pass queries (one object per change: type, path, edits or content) or a Codex-style patch string, not both; put a file's replacements in one query. Queries continue after a failed item; a patch validates everything first and stops at the first failure; neither rolls back. " +
					"Read an existing file before changing it; edits need exact text matching once (or replaceAll), and writes/deletes refuse stale content. Paths outside the workspace need approval.",
				promptGuidelines: [
					"File changes made here are checkpointed for /rewind and respect peer reservations; shell redirection, sed -i, interpreters and heredocs do neither. Batch related files in one call, and inspect what a formatter or generator rewrote.",
					"A call cut off by the output limit is not executed: write a very large file in parts (create it, then append with edits).",
				],
				parameters: Params,
				prepareArguments: renameReasoning,
				// `file` calls run one at a time (the guard, review dialog and checkpoints are shared); other tools batched beside
				// them still run in parallel. Each path's writes also queue behind Octocode's edit/write through withFileMutationQueue.
				execute: async (
					id: string,
					params: Static<typeof Params>,
					signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionToolContext,
				) => {
					validateFileInput(params);
					const canonical = params.patch !== undefined ? parsePatch(params.patch) : undefined;
					if (canonical?.environment_id)
						throw new Error("Remote patch environment routing is not available in this local file tool");
					let queries: FileQuery[] = canonical
						? patchChanges(params.patch!, params.reason ?? "Apply patch")
						: // `renameReasoning` gave every query a reason (its own, else the call's).
							(params.queries as FileQuery[]);
					if (!queries.length) {
						if (canonical)
							return {
								content: [{ type: "text" as const, text: "No files changed." }],
								details: { outcomes: [] },
							};
						throw new Error("No queries: pass at least one edit, write or delete query.");
					}
					// Octocode's own state folder is never changed: refused in every mode before any dialog asks for it.
					for (const query of queries) {
						const refusal = stateFolderRefusal(
							canonicalPath(resolveToolPath(ctx.cwd, query.path)),
							query.path,
							"the file tool",
						);
						if (!refusal) continue;
						permission.refused([`${query.type} ${query.path}`], refusal, "file");
						throw new Error(refusal);
					}
					const sourceBatch = !canonical && replacementOwner?.enabled(params, ctx.cwd) === true;
					const originalInspection = sourceBatch ? await inspectQueryBatch(queries, guard, ctx, signal) : undefined;
					let effectivePrepared: PreparedChange[] | undefined;
					let replacementCommitted = false;
					let reviewQueries = queries;
					const originalInvocation =
						ctx.invocation ?? captureToolInvocation(id, "file", params, () => !signal?.aborted);
					const invocationActive = () => originalInvocation?.active !== false;
					const prepareReplacement = async (proposals: FileInputReplacement[]) => {
						if (!sourceBatch || !replacementOwner) throw new Error("File replacement is unavailable for this call");
						let candidate: Record<string, unknown> = structuredClone(params);
						const indices = new Set<number>();
						for (const proposal of proposals) {
							if (
								!Number.isInteger(proposal.index) ||
								proposal.index < 0 ||
								proposal.index >= queries.length ||
								indices.has(proposal.index)
							)
								throw new Error("Invalid or duplicate file replacement index");
							indices.add(proposal.index);
							if (!isRecord(proposal.input)) throw new Error("File replacement must be an object");
							if (Object.keys(proposal.input).length)
								candidate = rewriteFileQuery(candidate, proposal.index, proposal.input);
						}
						candidate = validateToolArguments(
							{ name: "file", description: "File changes", parameters: Params },
							{
								type: "toolCall",
								id,
								name: "file",
								arguments: candidate as JsonObject,
							},
						);
						validateFileInput(candidate);
						const nextQueries = candidate.queries as FileQuery[];
						await replacementOwner.refresh(ctx);
						signal?.throwIfAborted();
						const inspected = await inspectQueryBatch(nextQueries, guard, ctx, signal, true);
						reviewQueries = nextQueries;
						const invocation = captureToolInvocation(
							id,
							"file",
							candidate,
							() => originalInvocation?.active !== false && !signal?.aborted,
						);
						return {
							fileIndices: [...indices],
							request: {
								action: "file.workspace" as const,
								...(inspected.outside ? { also: ["file.outside" as const] } : {}),
								title: "Apply replacement file changes?",
								what: nextQueries.map((query) => `${query.type} ${query.path}`),
								...changePurpose(nextQueries),
								toolCallId: id,
								cwd: ctx.cwd,
								signal,
								invocation,
							},
							commit: async (approvalSignal: AbortSignal, approvedSource: ReturnType<Permission["sourceDecision"]>) => {
								if (replacementCommitted || approvalSignal.aborted || signal?.aborted || !invocationActive())
									throw new Error("File replacement expired before commit");
								await replacementOwner.refresh(ctx);
								const final = await inspectQueryBatch(nextQueries, guard, ctx, approvalSignal, true);
								for (const [index, item] of final.prepared.entries())
									if (
										item.digest !== inspected.prepared[index].digest ||
										item.canonicalPath !== inspected.prepared[index].canonicalPath ||
										final.outside !== inspected.outside
									)
										throw changedOnDisk(item.query.path);
								const source = invocation && permission.replacementSourceDecision(invocation, ctx.cwd, [...indices]);
								if (
									source?.decision === "deny" ||
									source?.decision === "unsupported" ||
									(source?.decision === "ask" && approvedSource?.decision !== "ask")
								)
									throw new Error(source.message ?? "Source policy changed before file replacement commit");
								if (approvalSignal.aborted || signal?.aborted || !invocationActive())
									throw new Error("File replacement expired before commit");
								for (const key of Object.keys(params)) delete (params as Record<string, unknown>)[key];
								replacementOwner.committed?.(id, candidate, ctx.cwd);
								Object.assign(params, candidate);
								queries = params.queries as FileQuery[];
								effectivePrepared = final.prepared;
								replacementCommitted = true;
							},
						};
					};
					const approve: Permission["check"] = sourceBatch
						? (context, request, dialog) =>
								permission.checkWithFileReplacement(context, request, prepareReplacement, dialog)
						: permission.check.bind(permission);
					const outcomes: QueryOutcome[] = [];
					// When the mode asks (manual), the review is the ask: nothing is applied until the user has said yes to each
					// change (or to all of them). Without a UI to ask in, the batch is refused.
					let rejected = new Map<number, string | undefined>();
					const verdict = await approve(
						ctx,
						{
							action: "file.workspace",
							...(originalInspection?.outside ? { also: ["file.outside" as const] } : {}),
							...(sourceBatch ? { invocation: originalInvocation } : {}),
							title: "Apply these file changes?",
							what: queries.map((query) => `${query.type} ${query.path}`),
							...changePurpose(queries),
							toolCallId: id,
							cwd: ctx.cwd,
							...(signal ? { signal } : {}),
						},
						async (dialogCtx, request) => {
							const answer = await askReview(
								dialogCtx,
								reviewQueries,
								request.signal,
								systemLines(request, permission.mode),
								{ toolCallId: request.toolCallId ?? id, toolName: "file" },
							);
							if (answer === "cancelled") return undefined;
							if (answer === "session") return "kind";
							rejected = answer;
							if (answer.size !== reviewQueries.length) return "once";
							const notes = [...answer].flatMap(([index, note]) =>
								note ? [`${reviewQueries[index].path}: ${note}`] : [],
							);
							return notes.length > 0 ? { deny: notes.join("\n") } : "deny";
						},
					);
					// A dismissed or interrupted review is not a verdict on the changes.
					if ((!verdict.allowed && verdict.via === "cancelled") || signal?.aborted)
						throw new Error("Cancelled before any change was applied.");
					if (!verdict.allowed) throw new Error(verdict.message);
					if (sourceBatch && !replacementCommitted) {
						const final = await inspectQueryBatch(queries, guard, ctx, signal);
						if (
							final.outside !== originalInspection!.outside ||
							final.prepared.some(
								(item, index) => item.canonicalPath !== originalInspection!.prepared[index].canonicalPath,
							)
						)
							throw new Error("File target identity changed after approval; no changes applied");
					}
					if (canonical && rejected.size) throw new Error("Patch rejected; no changes applied");
					const prepared = canonical
						? await preparePatch(canonical, params.reason ?? "Apply patch", guard, ctx, signal, permission, id)
						: undefined;
					if (prepared) queries = prepared.map((item) => item.query);
					const parseBefore = feedback?.enabled
						? await captureParseBefore(
								queries.map((query) => canonicalPath(resolveToolPath(ctx.cwd, query.path))),
								ctx,
								signal,
							)
						: new Map();
					for (const [index, query] of queries.entries()) {
						const note = rejected.get(index);
						const skip = rejected.has(index)
							? `Rejected by the user; do not retry this change.${note ? ` User's note: ${note}` : ""}`
							: signal?.aborted
								? "Not applied: the batch was aborted."
								: undefined;
						const skipped = skip
							? {
									type: query.type,
									path: query.path,
									reason: query.reason,
									ok: false,
									message: skip,
								}
							: undefined;
						outcomes.push(
							skipped ??
								(await runQuery(
									query,
									id,
									guard,
									ctx,
									signal,
									permission,
									checkpoints,
									prepared?.[index] ?? effectivePrepared?.[index],
									sourceBatch ? (effectivePrepared ?? originalInspection!.prepared)[index].canonicalPath : undefined,
								)),
						);
						if (canonical && !outcomes.at(-1)!.ok) break;
					}
					const receipts = outcomes.flatMap((outcome) => (outcome.receipt ? [outcome.receipt] : []));
					const diagnostics = feedback?.enabled && receipts.length ? await inspectMutations(receipts, ctx, signal) : [];
					const parseFeedback =
						feedback?.enabled && receipts.length ? await inspectParseAfter(receipts, parseBefore, ctx, signal) : [];
					const isError = (canonical && !outcomes.at(-1)!.ok) || outcomes.every((outcome) => !outcome.ok);
					if (isError && !receipts.length) throw new Error(formatOutcomes(outcomes));
					const report = formatOutcomes(outcomes);
					return {
						content: [
							{
								type: "text" as const,
								text: [report, formatFeedback(diagnostics), formatParseFeedback(parseFeedback)]
									.filter(Boolean)
									.join("\n"),
							},
						],
						details: { outcomes, receipts, diagnostics, parseFeedback },
						...(isError ? { isError: true } : {}),
					};
				},
				renderCall: renderFileCall,
				renderResult: renderFileResult,
			},
			{ exclusive: true },
		),
	);

	api.on("tool_result", async (event, ctx) => {
		// A call another tool made may return content the script never showed the model, so only the model's own calls count as reads.
		if (event.isError || event.parentToolCallId) return;
		for (const read of recordedLocalReads(event.details)) guard.record(read.file, read, !read.whole, read.lines);
		const known = returnedContent(event.toolName, event.input, event.content, event.details);
		const view = readView(event.toolName, event.input, event.content, event.details);
		for (const file of readPaths(event.toolName, event.input, ctx.cwd))
			guard.record(file, known, view?.whole !== true, view?.lines);
		// A plain file printer in bash counts as a read whichever reader is available (`bashReads`).
		if (event.toolName !== "bash") return;
		const { command, background } = event.input;
		if (typeof command !== "string" || background === true) return;
		const details = asRecord(event.details);
		const cut = details.truncation !== undefined || details.fullOutputPath !== undefined;
		for (const read of bashReads(command, ctx.cwd, cut)) guard.record(read.file, undefined, !read.whole, read.lines);
	});
}
