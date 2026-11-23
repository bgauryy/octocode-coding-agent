import fs from "node:fs";
import path from "node:path";
import { generateDiffString, normalizeToLF } from "../../../core/tools/edit-diff.ts";
import { splitBom } from "@octocodeai/octocode-common/text";
import { FileLockReleaseError, withFileWriteLock } from "@octocodeai/octocode-common/file-write-lock";
import type { ToolContext } from "../../../core/features/index.ts";
import { withFileMutationQueue } from "../../../core/tools/file-mutation-queue.ts";
import type { Permission } from "../../permission/ask.ts";
import { changesOnlyWorkspace, runsLater } from "../../permission/file-access.ts";
import { protectedFileRefusal } from "./protected-files.ts";
import {
	atomicWriteFile,
	ChangedOnDiskError,
	changedOnDisk,
	sha256,
	sha256File,
} from "@octocodeai/octocode-common/atomic-file";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { workspaceRoot } from "../../../utils/git-repository.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { notify } from "../../shared/commands.ts";
import { resolveToolPath } from "../../shared/home.ts";
import { type Capture, type Checkpoints, lastUserEntry } from "../checkpoint.ts";
import { lineCount } from "../coverage.ts";
import type { MutationReceipt, QueryOutcome } from "../outcome.ts";
import { mutationEpoch, recordMutation } from "../feedback/revisions.ts";
import { applyEdit, applyWrite } from "./apply.ts";
import { resolveAnchoredEdits } from "./anchored.ts";
import { ownEdit } from "./own-edits.ts";
import { type FileGuard, judgeChange, lostAnchor, type WrittenContent } from "./guard.ts";
import { copiedElision, type FileQuery } from "./queries.ts";

/** One query of the `file` tool, run against the disk: the guard's checks, the checkpoint, and the change itself. */

/** The refusal when the path resolves elsewhere than where it was checked or approved (a folder on the way became a link). */
const TARGET_MOVED = "File target identity changed after approval; no changes applied";

const warnedCheckpoints = new WeakSet<Checkpoints>();

/**
 * Records a change in the checkpoint without failing the change itself. A failure means /rewind would miss this file,
 * so it is noted in the outcome and notified once per session.
 */
async function settleCheckpoint(
	ctx: ToolContext,
	checkpoints: Checkpoints | undefined,
	capture: Capture | undefined,
	file: string,
	ok: boolean,
	after?: string | null,
): Promise<string> {
	if (!checkpoints || !capture) return "";
	try {
		await checkpoints.settle(file, capture, ok, after);
		return "";
	} catch (error) {
		if (!warnedCheckpoints.has(checkpoints)) {
			warnedCheckpoints.add(checkpoints);
			if (ctx.ui)
				notify(
					ctx.ui,
					`Octocode could not save a checkpoint (${errorMessage(error)}); /rewind may not restore changed files.`,
					"warning",
				);
		}
		return " (checkpoint not saved: /rewind will not restore this change)";
	}
}

/** Largest written content, in characters, whose change is kept as a diff for the transcript. */
const WRITE_DIFF_MAX_CHARS = 64 * 1024;

/**
 * What a write changed, for display: every line added for a new file, else a diff against the bytes it replaced.
 * Undefined for large or binary content (the transcript keeps the diff) and for writes that changed nothing.
 */
function writeDiff(before: Buffer | undefined, content: string | undefined): string | undefined {
	if (content === undefined || content.length > WRITE_DIFF_MAX_CHARS) return undefined;
	if (before && (before.length > WRITE_DIFF_MAX_CHARS || before.includes(0))) return undefined;
	const old = before ? normalizeToLF(splitBom(before.toString("utf8")).text) : "";
	const next = normalizeToLF(content);
	if (old === next) return undefined;
	return generateDiffString(old, next).diff || undefined;
}

/**
 * Filesystem operations for Octocode's edit and write engines: writes are atomic and succeed only if the file still holds
 * what was checked (`checked`: the digest of `initial`, the bytes already read for this change; null = still absent).
 * Octocode's first read of that file is served from `initial` instead of the disk.
 */
function guardedOperations(
	display: string,
	checked: string | null,
	initial?: { file: string; data: Buffer },
	reserved?: () => void,
	signal?: AbortSignal,
	onCommit?: (digest: string) => void,
) {
	let read: string | undefined;
	let written: WrittenContent | undefined;
	let text: string | undefined;
	let unverified = false;
	let cached = initial;
	return {
		/** The digest and size of what the last write put on disk. */
		written: () => written,
		/** The text of the last write. */
		writtenText: () => text,
		/** The last write's read-back did not match what was written. */
		unverified: () => unverified,
		readFile: async (file: string) => {
			if (cached && cached.file === file && checked !== null) {
				const { data } = cached;
				cached = undefined;
				read = checked;
				return data;
			}
			const data = await fs.promises.readFile(file);
			read = sha256(data);
			return data;
		},
		writeFile: async (file: string, content: string) => {
			reserved?.();
			try {
				// The user's bytes are flushed; the directory is not (a crash may undo the rename, never tear the file).
				await atomicWriteFile(file, content, read ?? checked, {
					signal,
					beforeCommit: reserved,
					durability: "data",
				});
				const bytes = Buffer.from(content);
				written = {
					sha256: sha256(bytes),
					size: bytes.length,
					lines: lineCount(bytes),
				};
				text = content;
				onCommit?.(written.sha256);
			} catch (error) {
				if (error instanceof FileLockReleaseError) {
					const bytes = Buffer.from(content);
					written = {
						sha256: sha256(bytes),
						size: bytes.length,
						lines: lineCount(bytes),
					};
					onCommit?.(written.sha256);
				}
				throw error instanceof ChangedOnDiskError ? changedOnDisk(display) : error;
			}
			// Check the file after the write: one that is gone or has another size (torn, truncated or replaced right
			// after) must not report success. A stat, not a read: a change keeps to two reads (before it, and the
			// compare-and-swap), and a same-size rewrite is caught by the next change's compare-and-swap.
			const landed = await fs.promises.stat(file).then(
				(stat) => (stat.isFile() ? stat.size : null),
				() => null,
			);
			if (written && landed !== written.size) {
				unverified = true;
				throw new Error(
					`${display}: checking it after the write found ${landed === null ? "no file" : `a different size (${landed} bytes, expected ${written.size})`}: the write did not land intact, or another process changed the file right after it.`,
				);
			}
		},
		access: (file: string) => fs.promises.access(file, fs.constants.R_OK | fs.constants.W_OK),
		mkdir: async (dir: string) => {
			await fs.promises.mkdir(dir, { recursive: true });
		},
	};
}

export async function runQuery(
	query: FileQuery,
	id: string,
	guard: FileGuard,
	ctx: ToolContext,
	signal: AbortSignal | undefined,
	permission: Permission,
	checkpoints?: Checkpoints,
	prepared?: { mode: "edit" | "write" | "delete"; digest: string | null },
	approvedTarget?: string,
): Promise<QueryOutcome> {
	const mode = prepared?.mode ?? query.type;
	const base = { type: mode, path: query.path, reason: query.reason };
	const file = resolveToolPath(ctx.cwd, query.path);
	// Where every check below is made: the change lands only there (`reserved`, inside the write lock).
	const target = approvedTarget ?? canonicalPath(file);
	// Capture before any await: the live feature context may be retired during a committed write's cleanup.
	const sessionId = ctx.sessionManager?.getSessionId?.() ?? `standalone:${id}`;
	let capture: Capture | undefined;
	let operations: ReturnType<typeof guardedOperations> | undefined;
	let before: Buffer | undefined;
	let deleted = false;
	let beforeDigest: string | null = null;
	let receipt: MutationReceipt | undefined;
	const committed = (digest: string | null) => {
		if (receipt) return;
		receipt = {
			canonicalPath: canonicalPath(file),
			toolCallId: id,
			operation: mode,
			digest,
			beforeDigest,
			sessionId,
			epoch: mutationEpoch,
			revision: recordMutation(sessionId),
		};
	};
	try {
		if (query.type === "edit" && !query.edits?.length) throw new Error("edit needs a non-empty edits array.");
		if (query.type === "write" && query.content === undefined) throw new Error("write needs content.");
		const outside = await workspaceRefusal(file, query, ctx, signal, permission, id, approvedTarget);
		if (outside) throw new Error(outside);
		const inspection = guard.inspect(file, mode, query.path);
		if (inspection.refusal) throw new Error(inspection.refusal);
		const { current } = inspection;
		// Checked again right before the write: a peer may reserve the file while the change is prepared (asks, reads, checkpoint).
		const reserved = () => {
			if (canonicalPath(file) !== target) throw new Error(TARGET_MOVED);
			const now = guard.reservedBy?.(file);
			if (now) throw new Error(now);
		};
		// The one read before the change: it serves the content check, the checkpoint and Octocode's edit engine. The atomic
		// write's locked content check is the only other read.
		const data = current
			? await fs.promises.readFile(file).catch(() => {
					throw changedOnDisk(query.path);
				})
			: undefined;
		before = data;
		const checked = data ? sha256(data) : null;
		beforeDigest = checked;
		if (prepared && checked !== prepared.digest) throw changedOnDisk(query.path);
		// A write or delete over changed bytes is refused. An edit goes on when every anchor still matches once.
		const { changed, refusal: unfit } = judgeChange(query.path, mode, inspection, data, checked, guard.reader);
		if (unfit) throw new Error(unfit);
		const effective = query.type === "edit" && data ? resolveAnchoredEdits(query, data, guard, file) : query;
		const lost =
			!prepared && changed && data
				? lostAnchor(
						query.path,
						effective.edits ?? [],
						data.toString("utf8"),
						guard.reader,
						inspection.by,
						inspection.unread === true,
					)
				: undefined;
		if (lost) throw new Error(lost);
		const copied = copiedElision(effective, data?.toString("utf8") ?? "");
		if (copied) {
			throw new Error(
				`The new text contains "${copied}": a placeholder Octocode puts where it cut a tool's output, not file content. Re-read the source and write the full text.`,
			);
		}
		capture = await checkpoints?.capture(
			file,
			() => lastUserEntry(ctx),
			data && checked ? { data, sha256: checked, mode: current?.mode ?? 0o644 } : null,
		);
		const note = capture?.note ? ` (${capture.note})` : "";
		if (query.type === "delete") {
			await withFileMutationQueue(file, async () => {
				signal?.throwIfAborted();
				await withFileWriteLock(
					file,
					async (_target, assertHeld) => {
						if (((await sha256File(file)) ?? null) !== checked) throw changedOnDisk(query.path);
						assertHeld();
						reserved();
						await fs.promises.rm(file);
						deleted = true;
						committed(null);
					},
					signal,
				);
			});
			guard.record(file);
			const unsaved = await settleCheckpoint(ctx, checkpoints, capture, file, true, null);
			return {
				...base,
				ok: true,
				receipt,
				message: `Deleted ${query.path}${note}${unsaved}`,
			};
		}
		operations = guardedOperations(query.path, checked, data ? { file, data } : undefined, reserved, signal, committed);
		const applied =
			query.type === "edit"
				? await applyEdit(file, query.path, effective.edits ?? [], operations, signal)
				: await applyWrite(file, query.path, query.content ?? "", operations, signal);
		const written = operations.written();
		// An edit over outside changes leaves them unseen: later edits go on, a write or delete needs a fresh read.
		const lineDelta = recordChange(guard, file, mode, before, written, operations.writtenText());
		if (changed) guard.stale(file);
		// The digest a following anchored edit names, when the guard knows the file whole.
		const known = written && guard.wholeReadDigest(file) === written.sha256 ? written.sha256 : undefined;
		const unsaved = await settleCheckpoint(ctx, checkpoints, capture, file, true, written?.sha256);
		const message = (applied.message.trim() || `${query.type} ${query.path}`) + note + unsaved;
		const diff = applied.diff ?? (query.type === "write" ? writeDiff(data, query.content) : undefined);
		return {
			...base,
			ok: true,
			receipt,
			message,
			...(diff ? { diff } : {}),
			...(lineDelta !== undefined ? { lineDelta } : {}),
			...(known ? { sourceSha256: known } : {}),
		};
	} catch (error) {
		// Octocode can observe cancellation after writeFile succeeded: retain both the read guard and the undo checkpoint.
		const written = operations?.written();
		if (written) recordChange(guard, file, mode, before, written);
		// What the read-back found is not what the guard just recorded: the next change needs a fresh read.
		if (operations?.unverified()) guard.forget(file);
		if (deleted) guard.record(file);
		const note = await settleCheckpoint(
			ctx,
			checkpoints,
			capture,
			file,
			deleted || written !== undefined,
			deleted ? null : written?.sha256,
		);
		return {
			...base,
			ok: false,
			...(receipt ? { receipt } : {}),
			message: `${errorMessage(error)}${error instanceof ChangedOnDiskError ? guard.modifierNote(file) : ""}${written || deleted ? " The file was changed; inspect it before retrying." : ""}${note}`,
		};
	}
}

/**
 * Records what this tool wrote. A write puts known content on disk, so the agent knows the whole file; an edit only
 * knows the digest, and the agent keeps the coverage its reads had (`FileGuard.edited`). Returns an edit's change in
 * line count, for the outcome (the session rebuild applies the same rule from it).
 */
function recordChange(
	guard: FileGuard,
	file: string,
	type: FileQuery["type"],
	before: Buffer | undefined,
	written: WrittenContent | undefined,
	text?: string,
): number | undefined {
	if (type !== "edit") {
		guard.record(file, written);
		return undefined;
	}
	const lineDelta = written && before ? written.lines - lineCount(before) : undefined;
	// From the bytes this edit changed; the guard links it only when they are the version it knows whole.
	const from = before && sha256(before);
	const link = from && written && text !== undefined ? ownEdit(from, written.sha256, before, text) : undefined;
	guard.edited(file, written, lineDelta, link);
	return lineDelta;
}

/**
 * Why `file` may not be changed for its place: a curated memory file or Octocode's state folder (always refused), or
 * outside the repository and the `file.outside` ask was not allowed. Undefined when the change may go ahead.
 */
export async function workspaceRefusal(
	file: string,
	query: FileQuery,
	ctx: ToolContext,
	signal: AbortSignal | undefined,
	permission: Permission,
	toolCallId: string,
	approvedTarget?: string,
): Promise<string | undefined> {
	const real = canonicalPath(file);
	const home = protectedFileRefusal(real, query.path, ctx.cwd);
	if (home) {
		permission.refused([`${query.type} ${real}`], home, "file");
		return home;
	}
	if (approvedTarget) return real === approvedTarget ? undefined : TARGET_MOVED;
	const root = workspaceRoot(ctx.cwd);
	const inside = root !== undefined && changesOnlyWorkspace(real, root);
	if (inside && !runsLater(real, root)) return undefined;
	const dir = path.dirname(real);
	const verdict = await permission.check(ctx, {
		action: "file.outside",
		title: inside ? "Change a file that runs in later sessions?" : "Change a file outside the workspace?",
		what: [`${query.type} ${real}`, `workspace: ${root ?? "none (the home folder is not a workspace)"}`],
		purpose: query.reason,
		toolCallId,
		cwd: ctx.cwd,
		grant: { key: dir, label: `file changes under ${dir}` },
		...(signal ? { signal } : {}),
	});
	if (!verdict.allowed)
		return `${query.path} is ${inside ? "a file that runs in later sessions" : root ? `outside the workspace (${root})` : "outside any workspace (the home folder is not one)"}. ${verdict.message}`;
	// The answer is for the place the dialog named: a folder on the way swapped for a link while it was open moves the change.
	return canonicalPath(file) === real ? undefined : TARGET_MOVED;
}
