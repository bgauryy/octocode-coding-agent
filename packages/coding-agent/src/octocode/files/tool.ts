import {
	applyEditsToNormalizedContent,
	findAllEditOccurrences,
	generateDiffString,
	normalizeToLF,
} from "../../core/tools/edit-diff.ts";
import { splitBom } from "../../utils/text.ts";
import { type JsonObject, validateToolArguments } from "@octocodeai/octocode-ai";
import { captureToolInvocation } from "../../core/tools/tool-invocation.ts";
import { rewriteFileQuery, type FileInputReplacement } from "../shared/claude-file.ts";
import fs from "node:fs";
import path from "node:path";
import { type Static, Type } from "typebox";
import { FileLockReleaseError, withFileWriteLock } from "../../utils/file-write-lock.ts";
import type { ExtensionAPI, ExtensionToolContext } from "../../core/extensions/index.ts";
import { createEditToolDefinition, createWriteToolDefinition, withFileMutationQueue } from "../../core/tools/index.ts";
import type { Permission } from "../permission/ask.ts";
import { systemLines } from "../permission/effect.ts";
import { runsLater, stateFolderRefusal } from "../permission/gate.ts";
import { atomicWriteFile, changedOnDisk, sha256, sha256File } from "../shared/atomic.ts";
import { notify } from "../shared/commands.ts";
import { canonicalPath, isWithin, readPaths, resolveToolPath, workspaceRoot } from "../shared/home.ts";
import { timedTool } from "../shared/render.ts";
import { contentText, elisionMarkers, errorMessage, escapeRegExp, isRecord } from "../shared/util.ts";
import { type Capture, type Checkpoints, lastUserEntry } from "./checkpoint.ts";
import { describeRanges, firstGap, type LineRange, lineCount, mergeRanges, readView } from "./coverage.ts";
import { type QueryOutcome, renderFileCall, renderFileResult } from "./render.ts";
import { recordedLocalReads } from "../shared/local-reads.ts";
import { parsePatch, transformPatch, type ParsedPatch } from "../shared/codex-patch/patch.ts";
import { patchChanges, validateFileInput } from "../shared/file-input.ts";
import { askReview } from "./review.ts";

/**
 * Octocode's `file` tool: batched edit / write / delete queries, each with a
 * reasoning line. Edits and writes run through Octocode's own engines (exact-match
 * replacement, diffs, per-file mutation queue) but replace files atomically (temp file + rename) with a content check under a cross-process lock.
 * Writers outside Octocode that do not acquire that lock can still race the check. A file read with Octocode's `localFetch`, or changed by this
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

interface Snapshot {
	mtimeMs: number;
	ctimeMs: number;
	size: number;
	ino: number;
	mode: number;
	sha256?: string;
	/** The read showed a range or a truncated view, not the whole file. */
	partial?: boolean;
	/** For a partial view: the lines the reads showed so far (merged); a write needs them to cover the file. */
	lines?: LineRange[];
}

/** Content known without reading the file again (e.g. what was just written). */
interface KnownContent {
	sha256: string;
	size: number;
}

/** What this tool's last write put on disk: the digest and size, and the line count. */
interface WrittenContent extends KnownContent {
	lines: number;
}

interface Inspection {
	refusal?: string;
	/** The file's stat now; undefined when it does not exist. */
	current?: Snapshot;
	/** The digest the file's bytes must still have (known from the read or the last write), if any. */
	expected?: string;
	/** A write only: the lines the reads showed, when they did not show the whole file (see `unseenRefusal`). */
	lines?: readonly LineRange[];
	/** An edit only: the file changed since the read, so each oldText must be re-validated against its current content. */
	stale?: true;
}

/**
 * Why an edit's anchors do not fit `content` exactly: the first oldText that is gone or matches more than once, named,
 * with the instruction to read the file again. Undefined when each matches exactly once.
 */
/** The tool a refusal tells the model to read with, and how to ask that tool for a line range. */
export interface Reader {
	name: string;
	range(from: number, to: number): string;
}
/** Octocode's local reader, the default whenever the Octocode MCP server is running. */
export const LOCAL_FETCH_READER: Reader = {
	name: "localFetch",
	range: (from, to) => `ranges=["${from}-${to}"]`,
};
/** The core reader, active when Octocode's local readers are not (the MCP server is off or failed to start). */
export const CORE_READER: Reader = {
	name: "read",
	range: (from, to) => `offset=${from}, limit=${to - from + 1}`,
};

function lostAnchor(
	display: string,
	edits: ReadonlyArray<{ oldText: string; replaceAll?: boolean }>,
	content: string,
	reader: Reader,
): string | undefined {
	for (const [index, { oldText, replaceAll }] of edits.entries()) {
		const count = replaceAll
			? findAllEditOccurrences(normalizeToLF(content), normalizeToLF(oldText)).length
			: oldText === ""
				? 0
				: content.split(oldText).length - 1;
		if (replaceAll ? count > 0 : count === 1) continue;
		const shown = JSON.stringify(oldText.length > 60 ? `${oldText.slice(0, 60)}…` : oldText);
		return `${display} changed on disk since you last read it and edits[${index}] (oldText ${shown}) ${count === 0 ? "is no longer in it" : `now matches ${count} times`}. Read it again with \`${reader.name}\` before editing it.`;
	}
	return undefined;
}

function staleRefusal(display: string, reader: Reader): string {
	return `${display} changed on disk since you last read it. Read it again with \`${reader.name}\` before modifying it.`;
}

function unreadRefusal(display: string, reader: Reader): string {
	return `${display} already exists and was not read in this session. Read it with \`${reader.name}\` before modifying it.`;
}

/**
 * Why a full write over `data` is refused when the reads showed only `lines`: the first line never seen, and what to do
 * (each reader reaches any line by range, so this never asks for a whole-file read a big file cannot give). Undefined
 * when the reads covered every line.
 */
function unseenRefusal(display: string, lines: readonly LineRange[], data: Buffer, reader: Reader): string | undefined {
	const count = lineCount(data);
	const gap = firstGap(lines, count);
	if (gap === undefined) return undefined;
	return `${display}: a write replaces the whole file, but you have seen ${describeRanges(lines)} of its ${count} lines. Read the rest with \`${reader.name}\` (${reader.range(gap, count)}) until every line has been read, or use an edit to change part of it.`;
}

/**
 * What the bytes about to change say against what the guard knows (`inspection`, from `FileGuard.inspect`): `changed`
 * when they differ from what the read saw, and a refusal when a write or delete follows such a change, or a write
 * replaces lines the reads never showed. An edit over changes is not refused here: its anchors are re-validated.
 */
function judgeChange(
	display: string,
	mode: "edit" | "write" | "delete",
	inspection: Inspection,
	data: Buffer | undefined,
	checked: string | null,
	reader: Reader,
): { changed: boolean; refusal?: string } {
	const { stale, expected, lines } = inspection;
	const changed = stale === true || (expected !== undefined && expected !== checked);
	if (changed && mode !== "edit") return { changed, refusal: staleRefusal(display, reader) };
	const unseen = lines && data ? unseenRefusal(display, lines, data, reader) : undefined;
	return unseen ? { changed, refusal: unseen } : { changed };
}

function rereadRefusal(display: string, reader: Reader): string {
	return `${display}: your earlier read of it is no longer in your context. Read it again with \`${reader.name}\` before modifying it.`;
}

export class FileGuard {
	readonly #seen = new Map<string, Snapshot>();
	/** Files whose read left the context: changing them needs a fresh read first. */
	readonly #reread = new Set<string>();
	/** Files whose read is in the context but that were modified after it (known only by time, not by a snapshot). */
	readonly #changed = new Set<string>();
	/** Set by the team layer: why another agent's reservation forbids changing `file`, if it does. */
	reservedBy: ((file: string) => string | undefined) | undefined;
	/** The reader refusals name: Octocode's MCP owner switches it to core `read` while its local readers are unavailable. */
	reader: Reader = LOCAL_FETCH_READER;

	/**
	 * Remember the file as read now (stat only). `known`: its content digest when the caller has it (kept if the size
	 * agrees). `partial`: the read showed a range or a cut view, so a write needs the reads to cover every line (`lines`
	 * is what this read showed, when known); an edit or a delete does not. Reads of an unchanged file add up: a later
	 * range joins the earlier ones, and never takes back a whole read.
	 */
	record(file: string, known?: KnownContent, partial = false, lines?: LineRange): void {
		const real = canonicalPath(file);
		const stat = statOf(real);
		this.#reread.delete(real);
		// A read lifts the stale flag, but a range of a file that changed after its recorded read shows only that range of
		// the current file: the earlier ranges describe other bytes, so they are not carried over.
		const wasStale = this.#changed.delete(real);
		if (!stat) {
			this.#seen.delete(real);
			return;
		}
		const before = this.#seen.get(real);
		const same =
			!wasStale &&
			before !== undefined &&
			before.mtimeMs === stat.mtimeMs &&
			before.ctimeMs === stat.ctimeMs &&
			before.size === stat.size &&
			before.ino === stat.ino;
		if (partial && same && !before.partial) return;
		const covered = partial ? mergeRanges(same ? (before.lines ?? []) : [], lines) : undefined;
		this.#seen.set(real, {
			...stat,
			...(known && known.size === stat.size ? { sha256: known.sha256 } : {}),
			...(covered ? { partial: true, lines: covered } : {}),
		});
	}

	/**
	 * Record the file after this tool's own edit: its content digest is known (`known`), but the agent has seen only what
	 * its earlier reads showed, so a partial read stays partial. The ranges stay when the edit kept the line count
	 * (`lineDelta` 0); a different count moved the lines below the edit, so they are dropped and the reads start over.
	 * A file with no recorded read is not known to be seen at all.
	 */
	edited(file: string, known: KnownContent | undefined, lineDelta: number | undefined): void {
		const real = canonicalPath(file);
		const before = this.#seen.get(real);
		this.record(real, known);
		const now = this.#seen.get(real);
		if (!now || (before && !before.partial)) return;
		this.#seen.set(real, {
			...now,
			partial: true,
			lines: lineDelta === 0 ? (before?.lines ?? []) : [],
		});
	}

	/** The file's bytes changed after its read that the guard records (an edit applied over outside changes): a write or delete needs a fresh read. */
	stale(file: string): void {
		this.#changed.add(canonicalPath(file));
	}

	/** Forget one file, e.g. after /rewind replaced it: the model must read it again before writing it. */
	forget(file: string): void {
		const real = canonicalPath(file);
		this.#seen.delete(real);
		this.#changed.delete(real);
		this.#reread.add(real);
	}

	/**
	 * Rebuild the memory from what the context shows now (see `contextReads`), after a session start (resume, reload,
	 * fork), compaction or branch switch. A file read earlier but no longer in view must be read again. One in view
	 * counts as read when it was not modified after the read (`at`, ms); otherwise it is stale.
	 */
	restore(
		inContext: Iterable<{
			file: string;
			at: number;
			partial?: boolean;
			lines?: readonly LineRange[];
		}>,
	): void {
		for (const real of this.#seen.keys()) this.#reread.add(real);
		this.#seen.clear();
		this.#changed.clear();
		for (const { file, at, partial, lines } of inContext) {
			const real = canonicalPath(file);
			const stat = statOf(real);
			if (!stat) continue;
			this.#reread.delete(real);
			if (Math.max(stat.mtimeMs, stat.ctimeMs) <= at)
				this.#seen.set(real, {
					...stat,
					...(partial ? { partial, lines: mergeRanges(lines ?? []) } : {}),
				});
			else this.#changed.add(real);
		}
	}

	/**
	 * Returns an error message when the mutation must be refused, else undefined. An existing file must have been read
	 * (or written by this tool) in this session, and not changed on disk or left the context since; a new file is free.
	 * A write also needs every line of the file read (in one read or several); an edit does not, because its exact match
	 * proves the edited region was seen, and a delete needs only proof that the read was of the current file.
	 * `runQuery` applies the same two steps (`inspect`, then `judgeChange` over the bytes it reads); this runs them for
	 * callers that only ask (the guard's tests).
	 */
	check(file: string, mode: "edit" | "write" | "delete", display: string): string | undefined {
		const inspection = this.inspect(file, mode, display);
		if (inspection.refusal) return inspection.refusal;
		try {
			const data = inspection.current ? fs.readFileSync(file) : undefined;
			return judgeChange(display, mode, inspection, data, data ? sha256(data) : null, this.reader).refusal;
		} catch {
			return staleRefusal(display, this.reader);
		}
	}

	/**
	 * Like check, by stat alone (no read). Also returns the current stat and the digest the file must still have; the
	 * caller verifies that against the bytes it reads for the change.
	 */
	inspect(file: string, mode: "edit" | "write" | "delete", display: string): Inspection {
		const reserved = this.reservedBy?.(file);
		if (reserved) return { refusal: reserved };
		const real = canonicalPath(file);
		const current = statOf(real);
		if (!current) return mode === "edit" || mode === "delete" ? { refusal: `${display} does not exist.` } : {};
		if (this.#reread.has(real)) return { refusal: rereadRefusal(display, this.reader) };
		const edit = mode === "edit";
		if (this.#changed.has(real))
			return edit ? { current, stale: true } : { refusal: staleRefusal(display, this.reader) };
		const seen = this.#seen.get(real);
		if (!seen) return { refusal: unreadRefusal(display, this.reader) };
		// ctime and inode also move on a same-size rewrite that restored the mtime, or a rename over the file. With a
		// known digest a same-size move is left to the content check (a touch or a no-op rewrite is not a change).
		const moved =
			seen.mtimeMs !== current.mtimeMs ||
			seen.ctimeMs !== current.ctimeMs ||
			seen.size !== current.size ||
			seen.ino !== current.ino;
		if (moved && (!seen.sha256 || seen.size !== current.size))
			return edit ? { current, stale: true } : { refusal: staleRefusal(display, this.reader) };
		return {
			current,
			...(seen.sha256 ? { expected: seen.sha256 } : {}),
			...(seen.partial && mode === "write" ? { lines: seen.lines ?? [] } : {}),
		};
	}
}

function statOf(file: string): Snapshot | undefined {
	try {
		const stat = fs.statSync(file);
		return stat.isFile()
			? {
					mtimeMs: stat.mtimeMs,
					ctimeMs: stat.ctimeMs,
					size: stat.size,
					ino: stat.ino,
					mode: stat.mode,
				}
			: undefined;
	} catch {
		return undefined;
	}
}

const warnedCheckpoints = new WeakSet<Checkpoints>();

/**
 * Records a change in the checkpoint without failing the change itself. A failure means /rewind would miss this file,
 * so it is noted in the outcome and notified once per session.
 */
async function settleCheckpoint(
	ctx: ExtensionToolContext,
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

const QuerySchema = Type.Object({
	reasoning: Type.String({ description: "Why this change is needed" }),
	// A plain string enum (what octocode-ai's StringEnum emits) keeps the schema portable across providers.
	type: Type.Unsafe<"edit" | "write" | "delete">({
		type: "string",
		enum: ["edit", "write", "delete"],
		description:
			"edit: exact replacements; write: create/replace; delete: irreversible, only when the task requires it",
	}),
	path: Type.String({ description: "Absolute path or relative to cwd" }),
	edits: Type.Optional(
		Type.Array(
			Type.Object({
				oldText: Type.String({
					description: "Exact text; unique unless replaceAll is true",
				}),
				newText: Type.String({ description: "Replacement text" }),
				replaceAll: Type.Optional(
					Type.Boolean({
						description: "All non-overlapping matches; default false.",
					}),
				),
			}),
			{
				description: "Edits match original content; no overlaps.",
			},
		),
	),
	content: Type.Optional(Type.String({ description: "For write: complete file content" })),
});

const Params = Type.Object({
	queries: Type.Optional(Type.Array(QuerySchema)),
	patch: Type.Optional(
		Type.String({
			description: "Codex apply_patch text; use instead of queries",
		}),
	),
	reasoning: Type.Optional(Type.String({ description: "Why this patch is needed" })),
});
type FileQuery = Static<typeof QuerySchema>;

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
) {
	let read: string | undefined;
	let written: WrittenContent | undefined;
	let cached = initial;
	return {
		/** The digest and size of what the last write put on disk. */
		written: () => written,
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
				await atomicWriteFile(file, content, read ?? checked, {
					signal,
					beforeCommit: reserved,
				});
				const bytes = Buffer.from(content);
				written = {
					sha256: sha256(bytes),
					size: bytes.length,
					lines: lineCount(bytes),
				};
			} catch (error) {
				if (error instanceof FileLockReleaseError) {
					const bytes = Buffer.from(content);
					written = {
						sha256: sha256(bytes),
						size: bytes.length,
						lines: lineCount(bytes),
					};
				}
				throw /changed on disk/.test(errorMessage(error)) ? changedOnDisk(display) : error;
			}
		},
		access: (file: string) => fs.promises.access(file, fs.constants.R_OK | fs.constants.W_OK),
		mkdir: async (dir: string) => {
			await fs.promises.mkdir(dir, { recursive: true });
		},
	};
}

interface PreparedChange {
	query: FileQuery;
	mode: "edit" | "write" | "delete";
	digest: string | null;
	canonicalPath?: string;
}
async function preparePatch(
	patch: ParsedPatch,
	reasoning: string,
	guard: FileGuard,
	ctx: ExtensionToolContext,
	signal: AbortSignal | undefined,
	permission: Permission,
	id: string,
): Promise<PreparedChange[]> {
	const prepared: PreparedChange[] = [];
	const seen = new Set<string>();
	const destinations = new Set<string>();
	for (const hunk of patch.hunks) {
		const source = canonicalPath(resolveToolPath(ctx.cwd, hunk.path));
		if (seen.has(source)) throw new Error(`Duplicate patch operations target the same path: ${hunk.path}`);
		seen.add(source);
		const targets = new Set([
			source,
			...(hunk.kind === "update" && hunk.move_path !== null
				? [canonicalPath(resolveToolPath(ctx.cwd, hunk.move_path))]
				: []),
		]);
		if ([...targets].some((target) => destinations.has(target)))
			throw new Error("Overlapping patch operation targets require a sequential patch adapter; no changes applied");
		for (const target of targets) destinations.add(target);
	}
	seen.clear();
	const inspect = async (query: FileQuery, mode = query.type) => {
		signal?.throwIfAborted();
		const file = resolveToolPath(ctx.cwd, query.path);
		const outside = await workspaceRefusal(file, query, ctx, signal, permission, id);
		if (outside) throw new Error(outside);
		const check = guard.inspect(file, mode, query.path);
		if (check.refusal) throw new Error(check.refusal);
		const data = check.current ? await fs.promises.readFile(file) : undefined;
		const digest = data ? sha256(data) : null;
		const judged = judgeChange(query.path, mode, check, data, digest, guard.reader);
		if (judged.refusal) throw new Error(judged.refusal);
		const copied = copiedElision(query, data?.toString("utf8") ?? "");
		if (copied)
			throw new Error(
				`The new text contains "${copied}": an output-cut placeholder, not file content. Re-read the source and write the full text.`,
			);
		return { data, digest, changed: judged.changed };
	};
	for (const hunk of patch.hunks) {
		const source = resolveToolPath(ctx.cwd, hunk.path);
		const key = canonicalPath(source);
		if (seen.has(key)) throw new Error(`Duplicate patch operations target the same path: ${hunk.path}`);
		seen.add(key);
		if (hunk.kind === "add") {
			const query: FileQuery = {
				type: "write",
				path: hunk.path,
				content: hunk.content,
				reasoning,
			};
			const checked = await inspect(query);
			prepared.push({ query, mode: "write", digest: checked.digest });
		} else if (hunk.kind === "delete") {
			const query: FileQuery = { type: "delete", path: hunk.path, reasoning };
			const checked = await inspect(query);
			if (!checked.data) throw new Error(`Cannot delete missing file ${hunk.path}`);
			prepared.push({ query, mode: "delete", digest: checked.digest });
		} else {
			const edits = hunk.chunks
				.filter((c) => c.old.length)
				.map((c) => ({ oldText: c.old.join("\n"), newText: c.new.join("\n") }));
			const query: FileQuery = {
				type: "edit",
				path: hunk.path,
				edits,
				reasoning,
			};
			const checked = await inspect(query);
			if (!checked.data) throw new Error(`Cannot update missing file ${hunk.path}`);
			if (checked.changed) {
				const lost = lostAnchor(hunk.path, edits, checked.data.toString("utf8"), guard.reader);
				if (lost || !edits.length) throw new Error(lost ?? staleRefusal(hunk.path, guard.reader));
			}
			const content = transformPatch(checked.data.toString("utf8"), hunk.chunks);
			if (hunk.move_path !== null) {
				const destination: FileQuery = {
					type: "write",
					path: hunk.move_path,
					content,
					reasoning,
				};
				const target = await inspect(destination);
				// A move removes the source, so require the source deletion guard too.
				await inspect({ type: "delete", path: hunk.path, reasoning });
				prepared.push(
					{ query: destination, mode: "write", digest: target.digest },
					{
						query: { type: "delete", path: hunk.path, reasoning },
						mode: "delete",
						digest: checked.digest,
					},
				);
			} else
				prepared.push({
					query: { type: "write", path: hunk.path, content, reasoning },
					mode: "edit",
					digest: checked.digest,
				});
		}
	}
	return prepared;
}

interface FileReplacementOwner {
	enabled(input: Record<string, unknown>, cwd: string): boolean;
	refresh(ctx: ExtensionToolContext): Promise<void>;
	committed?(id: string, input: Record<string, unknown>): void;
}

async function inspectQueryBatch(
	queries: FileQuery[],
	guard: FileGuard,
	ctx: ExtensionToolContext,
	signal?: AbortSignal,
	rejectOverlap = false,
) {
	const targets = new Set<string>();
	const prepared: PreparedChange[] = [];
	let outside = false;
	for (const query of queries) {
		signal?.throwIfAborted();
		const file = resolveToolPath(ctx.cwd, query.path);
		const real = canonicalPath(file);
		const repeated = targets.has(real);
		if (rejectOverlap && repeated)
			throw new Error("Overlapping rewritten file targets require sequential preparation; no changes applied");
		targets.add(real);
		const state = stateFolderRefusal(real, query.path, "the file tool");
		if (state) throw new Error(state);
		const root = workspaceRoot(ctx.cwd);
		outside ||= !root || !isWithin(real, root) || runsLater(real, root);
		if (query.type === "edit" && !query.edits?.length) throw new Error("edit needs a non-empty edits array.");
		if (query.type === "write" && query.content === undefined) throw new Error("write needs content.");
		if (repeated) {
			const reserved = guard.reservedBy?.(file);
			if (reserved) throw new Error(reserved);
			// Unchanged native batches still evaluate later same-file queries after earlier mutations.
			prepared.push({
				query,
				mode: query.type,
				digest: null,
				canonicalPath: real,
			});
			continue;
		}
		const inspection = guard.inspect(file, query.type, query.path);
		if (inspection.refusal) throw new Error(inspection.refusal);
		const data = inspection.current ? await fs.promises.readFile(file) : undefined;
		signal?.throwIfAborted();
		const digest = data ? sha256(data) : null;
		const judged = judgeChange(query.path, query.type, inspection, data, digest, guard.reader);
		if (judged.refusal) throw new Error(judged.refusal);
		if (query.type === "edit") {
			if (judged.changed) {
				const lost = lostAnchor(query.path, query.edits ?? [], data?.toString("utf8") ?? "", guard.reader);
				if (lost) throw new Error(lost);
			}
			const content = splitBom(data?.toString("utf8") ?? "").text;
			applyEditsToNormalizedContent(normalizeToLF(content), query.edits ?? [], query.path);
		}
		const copied = copiedElision(query, data?.toString("utf8") ?? "");
		if (copied) throw new Error(`The new text contains "${copied}": an output-cut placeholder, not file content.`);
		prepared.push({ query, mode: query.type, digest, canonicalPath: real });
	}
	return { prepared, outside };
}

async function runQuery(
	query: FileQuery,
	index: number,
	id: string,
	guard: FileGuard,
	ctx: ExtensionToolContext,
	signal: AbortSignal | undefined,
	permission: Permission,
	checkpoints?: Checkpoints,
	prepared?: { mode: "edit" | "write" | "delete"; digest: string | null },
	approvedTarget?: string,
): Promise<QueryOutcome> {
	const mode = prepared?.mode ?? query.type;
	const base = { type: mode, path: query.path, reasoning: query.reasoning };
	const file = resolveToolPath(ctx.cwd, query.path);
	let capture: Capture | undefined;
	let operations: ReturnType<typeof guardedOperations> | undefined;
	let before: Buffer | undefined;
	let deleted = false;
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
			if (approvedTarget && canonicalPath(file) !== approvedTarget)
				throw new Error("File target identity changed after approval");
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
		if (prepared && checked !== prepared.digest) throw changedOnDisk(query.path);
		// A write or delete over changed bytes is refused. An edit goes on when every anchor still matches once.
		const { changed, refusal: unfit } = judgeChange(query.path, mode, inspection, data, checked, guard.reader);
		if (unfit) throw new Error(unfit);
		const lost =
			!prepared && changed && data
				? lostAnchor(query.path, query.edits ?? [], data.toString("utf8"), guard.reader)
				: undefined;
		if (lost) throw new Error(lost);
		const copied = copiedElision(query, data?.toString("utf8") ?? "");
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
					},
					signal,
				);
			});
			guard.record(file);
			const unsaved = await settleCheckpoint(ctx, checkpoints, capture, file, true, null);
			return {
				...base,
				ok: true,
				message: `Deleted ${query.path}${note}${unsaved}`,
			};
		}
		operations = guardedOperations(query.path, checked, data ? { file, data } : undefined, reserved, signal);
		const tool =
			query.type === "edit"
				? createEditToolDefinition(ctx.cwd, { operations })
				: createWriteToolDefinition(ctx.cwd, { operations });
		const args =
			query.type === "edit" ? { path: query.path, edits: query.edits } : { path: query.path, content: query.content };
		const result = await tool.execute(`${id}:${index}`, args as never, signal, undefined, ctx);
		const written = operations.written();
		// An edit over outside changes leaves them unseen: later edits go on, a write or delete needs a fresh read.
		const lineDelta = recordChange(guard, file, mode, before, written);
		if (changed) guard.stale(file);
		const unsaved = await settleCheckpoint(ctx, checkpoints, capture, file, true, written?.sha256);
		const message = (contentText(result.content).trim() || `${query.type} ${query.path}`) + note + unsaved;
		const diff =
			isRecord(result.details) && typeof result.details.diff === "string"
				? result.details.diff
				: query.type === "write"
					? writeDiff(data, query.content)
					: undefined;
		return {
			...base,
			ok: true,
			message,
			...(diff ? { diff } : {}),
			...(lineDelta !== undefined ? { lineDelta } : {}),
		};
	} catch (error) {
		// Octocode can observe cancellation after writeFile succeeded: retain both the read guard and the undo checkpoint.
		const written = operations?.written();
		if (written) recordChange(guard, file, mode, before, written);
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
			message: `${errorMessage(error)}${written || deleted ? " The file was changed; inspect it before retrying." : ""}${note}`,
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
): number | undefined {
	if (type !== "edit") {
		guard.record(file, written);
		return undefined;
	}
	const lineDelta = written && before ? written.lines - lineCount(before) : undefined;
	guard.edited(file, written, lineDelta);
	return lineDelta;
}

/**
 * Why `file` may not be changed for its place: inside Octocode's state folder (always refused, in every mode), or
 * outside the repository and the `file.outside` ask was not allowed. Undefined when the change may go ahead.
 */
async function workspaceRefusal(
	file: string,
	query: FileQuery,
	ctx: ExtensionToolContext,
	signal: AbortSignal | undefined,
	permission: Permission,
	toolCallId: string,
	approvedTarget?: string,
): Promise<string | undefined> {
	const real = canonicalPath(file);
	const home = stateFolderRefusal(real, query.path, "the file tool");
	if (home) {
		permission.refused([`${query.type} ${real}`], home, "file");
		return home;
	}
	if (approvedTarget) {
		if (real !== approvedTarget) return "File target identity changed after approval; no changes applied";
		return undefined;
	}
	const root = workspaceRoot(ctx.cwd);
	const inside = root !== undefined && isWithin(real, root);
	if (inside && !runsLater(real, root)) return undefined;
	const dir = path.dirname(real);
	const verdict = await permission.check(ctx, {
		action: "file.outside",
		title: inside ? "Change a file that runs in later sessions?" : "Change a file outside the workspace?",
		what: [`${query.type} ${real}`, `workspace: ${root ?? "none (the home folder is not a workspace)"}`],
		purpose: query.reasoning,
		toolCallId,
		cwd: ctx.cwd,
		grant: { key: dir, label: `file changes under ${dir}` },
		...(signal ? { signal } : {}),
	});
	return verdict.allowed
		? undefined
		: `${query.path} is ${inside ? "a file that runs in later sessions" : root ? `outside the workspace (${root})` : "outside any workspace (the home folder is not one)"}. ${verdict.message}`;
}

/** The batch's `purpose`: what its changes' `reasoning` fields say, in order; none when they say nothing (the assistant's message then stands in). */
function changePurpose(queries: readonly Pick<FileQuery, "reasoning">[]): {
	purpose?: string;
} {
	const said = [...new Set(queries.map((query) => query.reasoning?.trim()).filter(Boolean))];
	return said.length > 0 ? { purpose: said.join("; ") } : {};
}

/** The first output-cut placeholder a change would add to the file (one already in the file or the replaced text is fine). */
export function copiedElision(
	query: Pick<FileQuery, "type" | "edits" | "content">,
	original: string,
): string | undefined {
	const added =
		query.type === "write"
			? [{ oldText: "", newText: query.content ?? "" }]
			: query.type === "edit"
				? (query.edits ?? [])
				: [];
	for (const { oldText, newText } of added) {
		const found = elisionMarkers(newText).find((marker) => !oldText.includes(marker) && !original.includes(marker));
		if (found) return found;
	}
	return undefined;
}

/** Octocode's messages end with "in <path>." or "to <path>"; the outcome line already names the path. */
function withoutPath(message: string, file: string): string {
	return message.replace(new RegExp(`\\s+(?:in|to) ${escapeRegExp(file)}\\.?$`), "").replace(/^Successfully /, "");
}

export function formatOutcomes(outcomes: QueryOutcome[]): string {
	return outcomes
		.map(
			(outcome, index) =>
				`${index + 1}. ${outcome.ok ? "OK" : "FAILED"} ${outcome.type} ${outcome.path}: ${outcome.ok ? withoutPath(outcome.message, outcome.path) : outcome.message}`,
		)
		.join("\n");
}

/**
 * The digest of what Octocode's read returned when that is the whole file verbatim (no offset, limit or truncation), so the
 * guard checks the change against what the model saw rather than what the disk holds a moment later.
 */
export function returnedContent(
	toolName: string,
	input: Record<string, unknown>,
	content: unknown,
	details: unknown,
): KnownContent | undefined {
	if (readView(toolName, input, content, details)?.whole !== true) return undefined;
	if (!Array.isArray(content) || content.length !== 1 || !isRecord(content[0]) || content[0].type !== "text")
		return undefined;
	const text = content[0].text;
	return typeof text === "string" ? { sha256: sha256(text), size: Buffer.byteLength(text) } : undefined;
}

export function registerFileTool(
	pi: ExtensionAPI,
	guard: FileGuard,
	permission: Permission,
	checkpoints?: Checkpoints,
	replacementOwner?: FileReplacementOwner,
): void {
	pi.registerTool(
		timedTool(
			{
				name: "file",
				label: "File",
				description:
					"Create, edit or delete files; outside paths need approval in manual/workspace modes. Batch each file’s replacements in one query. Queries continue after failures; patch validates all operations first and stops on execution failure. Neither mode rolls back earlier changes. " +
					"Read existing files first. Writes/deletes refuse stale content; edits require current matches (unique unless replaceAll). Inspect every outcome.",
				promptSnippet: "Create, edit or delete files (guarded)",
				promptGuidelines: [
					"Use file for authored changes; batch related files when useful. Run formatters, generators and builds with bash, then inspect their changes.",
				],
				parameters: Params,
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
						? patchChanges(params.patch!, params.reasoning ?? "Apply patch")
						: params.queries!;
					if (!queries.length) {
						if (canonical)
							return {
								content: [{ type: "text" as const, text: "No files changed." }],
								details: { outcomes: [] },
							};
						throw new Error("No queries: pass at least one edit, write or delete query.");
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
										item.digest !== inspected.prepared[index]!.digest ||
										item.canonicalPath !== inspected.prepared[index]!.canonicalPath ||
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
								replacementOwner.committed?.(id, candidate);
								Object.assign(params, candidate);
								queries = params.queries!;
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
							);
							if (answer === "cancelled") return undefined;
							if (answer === "session") return "kind";
							rejected = answer;
							if (answer.size !== reviewQueries.length) return "once";
							const notes = [...answer].flatMap(([index, note]) =>
								note ? [`${reviewQueries[index]!.path}: ${note}`] : [],
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
								(item, index) => item.canonicalPath !== originalInspection!.prepared[index]!.canonicalPath,
							)
						)
							throw new Error("File target identity changed after approval; no changes applied");
					}
					if (canonical && rejected.size) throw new Error("Patch rejected; no changes applied");
					const prepared = canonical
						? await preparePatch(canonical, params.reasoning ?? "Apply patch", guard, ctx, signal, permission, id)
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
									reasoning: query.reasoning,
									ok: false,
									message: skip,
								}
							: undefined;
						outcomes.push(
							skipped ??
								(await runQuery(
									query,
									index,
									id,
									guard,
									ctx,
									signal,
									permission,
									checkpoints,
									prepared?.[index] ?? effectivePrepared?.[index],
									sourceBatch ? (effectivePrepared ?? originalInspection!.prepared)[index]!.canonicalPath : undefined,
								)),
						);
						if (canonical && !outcomes.at(-1)!.ok) throw new Error(formatOutcomes(outcomes));
						if (prepared) {
							const target = canonicalPath(resolveToolPath(ctx.cwd, query.path));
							const digest = query.type === "delete" ? null : sha256(Buffer.from(query.content ?? ""));
							for (const next of prepared.slice(index + 1))
								if (canonicalPath(resolveToolPath(ctx.cwd, next.query.path)) === target) next.digest = digest;
						}
					}
					if (outcomes.every((outcome) => !outcome.ok)) throw new Error(formatOutcomes(outcomes));
					return {
						content: [{ type: "text" as const, text: formatOutcomes(outcomes) }],
						details: { outcomes },
					};
				},
				renderCall: renderFileCall,
				renderResult: renderFileResult,
			},
			{ exclusive: true },
		),
	);

	pi.on("tool_result", async (event, ctx) => {
		// A call another tool made may return content the script never showed the model, so only the model's own calls count as reads.
		if (event.isError || event.parentToolCallId) return;
		for (const read of recordedLocalReads(event.details)) guard.record(read.file, read, !read.whole, read.lines);
		const known = returnedContent(event.toolName, event.input, event.content, event.details);
		const view = readView(event.toolName, event.input, event.content, event.details);
		for (const file of readPaths(event.toolName, event.input, ctx.cwd))
			guard.record(file, known, view?.whole !== true, view?.lines);
	});
}
