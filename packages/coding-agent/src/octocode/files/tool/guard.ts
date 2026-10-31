import fs from "node:fs";
import { findAllEditOccurrences, normalizeToLF } from "../../../core/tools/edit-diff.ts";
import { sha256 } from "../../../../../common/src/atomic-file.ts";
import { canonicalPath } from "../../shared/home/repo.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";
import { describeRanges, firstGap, type LineRange, lineCount, mergeRanges, readView } from "../coverage.ts";

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
export interface WrittenContent extends KnownContent {
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
/**
 * The reader while Octocode's local readers are unavailable (the MCP server is off or failed to start): `bash`, whose reads
 * of a file count when they are a plain `cat`, `head`, `tail -n +N` or `sed -n 'A,Bp'` (`files/bash-reads`).
 */
export const BASH_READER: Reader = {
	name: "bash",
	range: (from, to) => `sed -n '${from},${to}p' <file>`,
};

export function lostAnchor(
	display: string,
	edits: ReadonlyArray<{ oldText: string; replaceAll?: boolean }>,
	content: string,
	reader: Reader,
): string | undefined {
	const normalized = normalizeToLF(content);
	for (const [index, { oldText, replaceAll }] of edits.entries()) {
		const anchor = normalizeToLF(oldText);
		const count = replaceAll
			? findAllEditOccurrences(normalized, anchor).length
			: anchor === ""
				? 0
				: normalized.split(anchor).length - 1;
		if (replaceAll ? count > 0 : count === 1) continue;
		const shown = JSON.stringify(oldText.length > 60 ? `${oldText.slice(0, 60)}…` : oldText);
		return `${display} changed on disk since you last read it and edits[${index}] (oldText ${shown}) ${count === 0 ? "is no longer in it" : `now matches ${count} times`}. Read it again with \`${reader.name}\` before editing it.`;
	}
	return undefined;
}

export function staleRefusal(display: string, reader: Reader): string {
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
export function judgeChange(
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
	/** The reader refusals name: Octocode's MCP owner switches it to `BASH_READER` while its local readers are unavailable. */
	reader: Reader = LOCAL_FETCH_READER;

	/** A digest only when the current context contains a complete read of this source. */
	wholeReadDigest(file: string): string | undefined {
		const real = canonicalPath(file);
		if (this.#reread.has(real) || this.#changed.has(real)) return undefined;
		const seen = this.#seen.get(real);
		return seen?.partial ? undefined : seen?.sha256;
	}

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
