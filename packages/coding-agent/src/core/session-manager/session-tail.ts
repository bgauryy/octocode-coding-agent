import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { parseJsonlLine } from "@octocodeai/octocode-common/jsonl";
import { scheduleSessionSync } from "./deferred-sync.ts";
import { generateId } from "./entries.ts";
import { forkHint, mergeForeignEntries } from "./shared-file.ts";
import { SESSION_RECOVERY_ENTRY, type SealedLine } from "./sealed-line.ts";
import type { SessionState } from "./state.ts";
import type { CustomEntry, SessionEntry } from "./types.ts";

/**
 * The end of a session file. A writer that stops in the middle of an append (a crash, a kill, a power loss before the
 * deferred sync reached the drive) leaves part of a record after the last newline, and every later append would run into
 * it. Nothing is ever cut: the next write, under the session lock, ends that part with a newline, so it stays in the
 * file byte for byte as one malformed line that every reader skips, and writes right after it a `custom` record
 * (`SESSION_RECOVERY_ENTRY`) naming its bytes. That record is how another process's merge, which refuses a malformed
 * line it cannot account for, knows the line was sealed under the lock and steps over it.
 */

/** Offset just past the last newline of `fd` (0 when there is none), reading backwards in blocks. */
export function endOfLastRecord(fd: number, size: number): number {
	const block = Buffer.alloc(64 * 1024);
	for (let end = size; end > 0;) {
		const start = Math.max(0, end - block.length);
		const read = readSync(fd, block, 0, end - start, start);
		const at = block.subarray(0, read).lastIndexOf(10);
		if (at >= 0) return start + at + 1;
		end = start;
	}
	return 0;
}

/** The file's size and modification time (ns), as one `fstat` read them. */
export interface FileEnd {
	size: number;
	mtime: string;
}

/** How the file ends, and its last line (`offset`, `bytes`) when that line has no newline. */
type Tail = ({ kind: "whole" } | ({ kind: "unterminated" | "torn" } & SealedLine)) & FileEnd;

/**
 * How the file ends: `whole` (empty, or a newline), `unterminated` (a whole record lacking only its newline: a hand
 * edit, or a writer that stopped just before it) or `torn` (bytes after the last newline that are not JSON: part of a
 * record). Throws when the end is neither: no whole line before it (the header itself was cut off), or JSON that is not
 * a record.
 */
function readTail(file: string): Tail {
	const fd = openSync(file, "r");
	try {
		const stat = fstatSync(fd, { bigint: true });
		const size = Number(stat.size);
		const mtime = String(stat.mtimeNs);
		const last = Buffer.alloc(1);
		if (size === 0 || (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 10))
			return { kind: "whole", size, mtime };
		const start = endOfLastRecord(fd, size);
		const tail = Buffer.alloc(size - start);
		if (start > 0 && readSync(fd, tail, 0, tail.length, start) === tail.length) {
			const parsed = parseJsonlLine(tail.toString("utf8"));
			if (!parsed || (parsed.ok && typeof parsed.value === "object" && parsed.value !== null)) {
				return { kind: "unterminated", size, mtime, offset: start, bytes: tail.length };
			}
			if (!parsed.ok) return { kind: "torn", size, mtime, offset: start, bytes: tail.length };
		}
		throw new Error(`Session has an incomplete final record. ${forkHint(file)}`);
	} finally {
		closeSync(fd);
	}
}

/** Whether `file` ends in part of a record: a write that was cut off. A read-only check for a UI to say so. */
export function hasTornTail(file: string): boolean {
	try {
		if (statSync(file).size === 0) return false;
		return readTail(file).kind === "torn";
	} catch {
		return existsSync(file);
	}
}

/** The recovery record naming `sealed`, as the next line of the file: a child of `parentId`. */
function recoveryEntry(state: SessionState, sealed: SealedLine, parentId: string | null): CustomEntry<SealedLine> {
	return {
		type: "custom",
		customType: SESSION_RECOVERY_ENTRY,
		id: generateId(state.byId),
		parentId,
		timestamp: new Date().toISOString(),
		data: { offset: sealed.offset, bytes: sealed.bytes },
	};
}

/**
 * With the session lock held, before `pending` is merged and appended: end the file's last line. Records before it are
 * merged first (`mergeForeignEntries`), so a file the merge refuses is left as it was. A record lacking only its newline
 * gets it. Part of a record is sealed, and the recovery record naming it goes in the same append, as a child of
 * `pending[0]`'s parent; the merge that follows reads that record like any other, and the caller makes it `pending[0]`'s
 * parent (`adoptRecovery`). Returns the recovery record's id (`recovery`), and the file's end (`end`) when nothing was
 * written here, so the merge and the append need no stat of their own. Throws, writing nothing, when the end is not
 * provably part of a record (`readTail`). A file that shrank is left to the merge, which refuses it.
 */
export function endSessionTail(
	state: SessionState,
	file: string,
	pending: SessionEntry[],
): { recovery?: string; end?: FileEnd } {
	if (pending.length === 0) return {};
	const tail = readTail(file);
	const end = { size: tail.size, mtime: tail.mtime };
	if (tail.kind === "whole") return { end };
	const known = state.fileSize;
	if (known === undefined) throw new Error(`Session has an incomplete final record. ${forkHint(file)}`);
	if (tail.size < known) return { end };
	if (known < tail.offset) mergeForeignEntries(state, file, pending, tail.offset);
	if (tail.kind === "unterminated") {
		appendFileSync(file, "\n");
		// Known to this state already (it read or wrote the record): stay level with the file.
		if (state.fileSize === tail.size) state.fileSize += 1;
		scheduleSessionSync(file);
		return {};
	}
	const entry = recoveryEntry(state, tail, pending.length ? pending[0].parentId : state.leafId);
	appendFileSync(file, `\n${state.codec.line(entry)}\n`);
	scheduleSessionSync(file);
	return { recovery: entry.id };
}

/** After the merge: the recovery record `id` becomes the parent of `pending[0]`, so the branch stays one line. */
export function adoptRecovery(state: SessionState, id: string | undefined, pending: readonly SessionEntry[]): void {
	const recovery = id === undefined ? undefined : state.byId.get(id);
	const first = pending[0];
	if (!recovery || !first || first.parentId !== recovery.parentId) return;
	first.parentId = recovery.id;
}
