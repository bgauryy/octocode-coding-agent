import { fileDisplay } from "../../../files/display.ts";
import { KILL_GRACE_MS } from "../../../shared/process.ts";
import { PS_TIMEOUT_MS } from "../../../shared/process-table.ts";
import { renderPrompt } from "../../../../core/prompt-template.ts";
import { type JsonObject, validateToolArguments } from "@octocodeai/octocode-ai";
import { captureToolInvocation } from "../../../../core/tools/tool-invocation.ts";
import { rewriteFileQuery, type FileInputReplacement } from "../../../tool-input/claude-file.ts";
import type { Static } from "typebox";
import type { FeatureSetup, ToolContext } from "../../../../core/features/index.ts";
import type { Permission } from "../../../permission/ask.ts";
import { declareToolEffect } from "../../../permission/tool-effects.ts";
import { systemLines } from "../../../permission/effect.ts";
import { changedOnDisk } from "@octocodeai/octocode-common/atomic-file";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { timedTool } from "../../../render/rows.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import { readPaths, resolveToolPath } from "../../../shared/home.ts";
import type { Checkpoints } from "../../../files/checkpoint.ts";
import { readView } from "../../../files/coverage.ts";
import type { QueryOutcome } from "../../../files/outcome.ts";
import { renderFileCall, renderFileResult } from "../../../files/render.ts";
import { recordedLocalReads } from "../../../shared/local-reads.ts";
import { parsePatch } from "../../../tool-input/codex-patch/patch.ts";
import { FILE_TOOL_EFFECT, patchChanges, validateFileInput } from "../../../tool-input/file-input.ts";
import { askReview } from "../../../files/review.ts";
import { bashReads } from "../../../files/bash-reads.ts";
import { repeatReadNotes } from "../../../files/repeat-reads.ts";
import { type FileGuard, returnedContent } from "../../../files/tool/guard.ts";
import { protectedFileRefusal } from "../../../files/tool/protected-files.ts";
import { inspectQueryBatch, preparePatch } from "../../../files/tool/prepare.ts";
import { type AttachmentContent, withAttachments } from "../../../files/tool/attachment-source.ts";
import {
	changePurpose,
	type FileQuery,
	type FileReplacementOwner,
	batchText,
	Params,
	type PreparedChange,
	renameReasoning,
} from "../../../files/tool/queries.ts";
import { runQuery } from "../../../files/tool/run.ts";
export { projectEditHunk } from "../../../files/tool/patch-projection.ts";

/**
 * Batch review may cancel a command hook: allow its two bounded POSIX snapshots and TERM/KILL settle phases,
 * plus result delivery. Current Windows command hooks use taskkill without a job-helper RPC wait.
 */
const FILE_ABORT_GRACE_MS = 2 * PS_TIMEOUT_MS + 2 * KILL_GRACE_MS + 500;

/**
 * Octocode's `file` tool: batched edit / write / delete queries, each with a
 * reason line. Edits and writes run through the engines of `tool/apply.ts` (exact replacement with a
 * whitespace/punctuation fallback, diffs, per-file mutation queue) but replace files atomically (temp file + rename) with a content check under a cross-process lock.
 * Writers outside Octocode that do not acquire that lock can still race the check. A file read with an MCP reader role (or printed by a plain `bash` command, see `bash-reads.ts`), or changed by this
 * tool, that changed on disk since then must be read again before a write or delete; an edit re-validates each oldText
 * against the current content and applies when each still matches exactly once, also for a file never read (the match proves the content is known). A file whose earlier read left the
 * context (compaction, a branch switch, a rewind that restored it) must be read again before
 * it is changed, even if the disk did not move.
 *
 * Paths are checked against the workspace first: Octocode's own state folder (the Octocode home, holding trust
 * decisions, memory and sessions) and the curated MEMORY.md files (the `memory` tool's) are never changed, and a path
 * outside the repository is a `file.outside` permission ask. In `manual` mode the batch's review dialog is its `file.workspace` ask.
 *
 * A read is recorded by stat (size, mtime, ctime, inode) of the canonical path, without reading the file again; its
 * digest is known only when the read returned the whole file (a credited whole read) or the file tool wrote it, and is then
 * checked against the bytes the change reads anyway. Residual race: a file changed between the read tool reading it
 * and the stat here is taken as read (unless its digest was known from the returned text).
 */

export function registerFileTool(
	api: FeatureSetup,
	guard: FileGuard,
	permission: Permission,
	checkpoints?: Checkpoints,
	replacementOwner?: FileReplacementOwner,
	/** Reads a `fromAttachment` reference: the team layer's (`team/attachment-source.ts`), wired by the composition root. */
	attachmentContent?: AttachmentContent,
): void {
	api.tools.register(
		declareToolEffect(
			timedTool(
				{
					name: "file",
					abortGraceMs: FILE_ABORT_GRACE_MS,
					label: "File",
					promptSnippet: renderPrompt("tools/file/snippet.md"),
					description:
						"Applies file changes; it does not read. Send queries or a Codex-style patch, never both; group a file's replacements in one query. Queries continue past failures; a patch validates everything, then stops at the first failure; neither rolls back. Read an existing file before write (all lines) or delete: the declared read tool's reads count, as do search content rows (their lines) and unpiped bash prints. Edits need no read when every oldText matches exactly. Stale files refuse write/delete; paths outside the workspace need approval.",
					promptGuidelines: renderPrompt("tools/file/guidelines.md").split("\n"),
					parameters: Params,
					prepareArguments: renameReasoning,
					// Exclusive in its batch: a `file` call starts after every earlier call of the message ended and every later one
					// waits for it, so a read or a check batched after an edit sees the edit. Calls on either side still overlap.
					executionMode: "sequential",
					// The permission layer reads this instead of a list of tool names: every change names its path.
					effect: FILE_TOOL_EFFECT,
					// `file` calls also run one at a time across batches (the guard, review dialog and checkpoints are shared). Each
					// path's writes also queue behind Octocode's edit/write through withFileMutationQueue.
					execute: async (
						id: string,
						params: Static<typeof Params>,
						signal: AbortSignal | undefined,
						_onUpdate: unknown,
						ctx: ToolContext,
					) => {
						validateFileInput(params);
						const canonical = params.patch !== undefined ? parsePatch(params.patch) : undefined;
						if (canonical?.environment_id)
							throw new Error("Remote patch environment routing is not available in this local file tool");
						let queries: FileQuery[] = canonical
							? patchChanges(params.patch!, params.reason ?? "Apply patch")
							: // `renameReasoning` gave every query a reason (its own, else the call's).
								(params.queries as FileQuery[]);
						if (!queries.length)
							throw new Error(
								canonical
									? "Empty patch: it changes no file. Put at least one `*** Add File:`, `*** Update File:` or `*** Delete File:` section between `*** Begin Patch` and `*** End Patch`."
									: "No queries: pass at least one edit, write or delete query.",
							);
						// An attachment's text joins its write here, so every check below sees the bytes that will be written.
						if (!canonical) queries = withAttachments(queries, ctx, attachmentContent);
						// A curated memory file and Octocode's own state folder are never changed: refused in every mode before any dialog asks.
						for (const query of queries) {
							const refusal = protectedFileRefusal(
								canonicalPath(resolveToolPath(ctx.cwd, query.path)),
								query.path,
								ctx.cwd,
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
							const nextQueries = withAttachments(candidate.queries as FileQuery[], ctx, attachmentContent);
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
								commit: async (
									approvalSignal: AbortSignal,
									approvedSource: ReturnType<Permission["sourceDecision"]>,
								) => {
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
									queries = nextQueries;
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
						// Any failed query makes the result an error. Its `details.outcomes` still name what was applied
						// (`appliedFileOutcomes`), which is what a consumer reads, not the error flag.
						const failed = outcomes.filter((outcome) => !outcome.ok).length;
						const isError = failed > 0;
						const text = batchText(outcomes, failed, canonical ? undefined : queries.length);
						if (isError && !receipts.length) throw new Error(text);
						return {
							content: [{ type: "text" as const, text }],
							details: { outcomes, receipts },
							...(isError ? { isError: true } : {}),
						};
					},
					renderCall: renderFileCall,
					renderResult: renderFileResult,
					display: fileDisplay,
				},
				{ exclusive: true },
			),
		),
	);

	const repeats = repeatReadNotes();
	api.bus.on("tool_result", async (event, ctx) => {
		// A call another tool made may return content the script never showed the model, so only the model's own calls count as reads.
		if (event.isError || event.parentToolCallId) return undefined;
		for (const read of recordedLocalReads(event.details)) guard.record(read.file, read, !read.whole, read.lines);
		const known = returnedContent(event.toolName, event.input, event.content, event.details);
		const view = readView(event.toolName, event.input, event.content, event.details);
		for (const file of readPaths(event.toolName, event.input, ctx.cwd))
			guard.record(file, known, view?.whole !== true, view?.lines);
		// A plain file printer in bash counts as a read whichever reader is available (`bashReads`).
		if (event.toolName === "bash") {
			const { command, background } = event.input;
			const details = asRecord(event.details);
			const cut = details.truncation !== undefined || details.fullOutputPath !== undefined;
			if (typeof command === "string" && background !== true)
				for (const read of bashReads(command, ctx.cwd, cut))
					guard.record(read.file, undefined, !read.whole, read.lines);
		}
		// Once the guard has credited the read: a repeated whole read of an unchanged file becomes a note pointing at the first.
		return repeats(event, ctx);
	});
}
