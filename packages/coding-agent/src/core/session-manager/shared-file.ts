import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { APP_NAME } from "../../config.ts";
import { canonicalPath } from "../../../../common/src/canonical-path.ts";
import { breakDeadLockSync, guardLockOwner } from "../../../../common/src/lock-owner.ts";
import { type JsonlLine, parseJsonlLine } from "../../../../common/src/jsonl.ts";
import { generateId } from "./entries.ts";
import { sealsLine } from "./sealed-line.ts";
import type { SessionState } from "./state.ts";
import { indexSessionEntry } from "./tree.ts";
import type { SessionEntry } from "./types.ts";

// Another octocode process can continue the same session file. Every write runs under a short lock on the file,
// and foreign records appended since this state's last write are merged into memory first. A file that shrank or
// ends in a partial record is never written to.

/** The way out of a session file that cannot be written: a fork copies its complete records and leaves it byte-identical. */
export function forkHint(file: string): string {
	return `Run \`${APP_NAME} --fork ${file}\` to continue in a copy of its complete records; this file stays as it is.`;
}

/** Longest a write waits for another process's lock; the holder keeps it for a few milliseconds. */
const LOCK_WAIT_MS = 3000;
/**
 * Appended records try once, then stay in memory for the asynchronous retry (`held-retry.ts`).
 * Waiting even briefly here blocks input and rendering once per record.
 */
export const HELD_LOCK_WAIT_MS = 0;

/**
 * Mirror reads have a fallback (a rebuild, a later append or the next open repairs the mirror), so they never wait.
 */
export const READER_LOCK_WAIT_MS = 0;

function pause(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take `<file>.lock` and record this process as its owner (`lock-owner.ts`), polling with a short randomized sleep so
 * two writers appending back to back cannot starve each other the way fixed-interval polling can. A lock whose recorded
 * owner is verifiably gone (killed, crashed) is taken over at once; one held by a live or unknown owner is waited for,
 * and the lock error is thrown after `waitMs`.
 */
function acquireSessionLock(file: string, waitMs: number): () => void {
	const lockfilePath = `${file}.lock`;
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			const guard = guardLockOwner(lockfilePath);
			guard.check();
			const release = lockfile.lockSync(file, { realpath: false, lockfilePath, fs: guard.fs });
			const forget = guard.acquired();
			return () => {
				try {
					release();
				} finally {
					forget();
				}
			};
		} catch (error) {
			const held = (error as { code?: unknown } | null)?.code === "ELOCKED";
			if (!held) throw error;
			if (breakDeadLockSync(lockfilePath)) continue;
			if (Date.now() >= deadline) throw error;
			pause(1 + Math.random() * 6);
		}
	}
}

/** Whether `error` is a lock another process held past `LOCK_WAIT_MS`; nothing was written, so the write may be retried. */
export function isSessionLockTimeout(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === "ELOCKED";
}

/**
 * Take the cross-process lock `<file>.lock` and return its release, for a write whose locked part does not fit one
 * callback (`rewriteSessionFile`). The release never throws: a failed one leaves a stale lock that is reclaimed.
 */
export function lockSessionFile(file: string, waitMs = LOCK_WAIT_MS): () => void {
	// A new session may belong to a folder that does not exist yet (the workspace folder, for a session opened from the legacy one).
	mkdirSync(dirname(file), { recursive: true });
	const release = acquireSessionLock(canonicalPath(file), waitMs);
	return () => {
		try {
			release();
		} catch {
			// The write already succeeded or failed on its own terms.
		}
	};
}

/**
 * Run `write` while holding the cross-process lock `<file>.lock` (`lockSessionFile`). `waitMs`: how long a live holder
 * is waited for; a reader with a fallback passes less than a writer.
 */
export function withSessionFileLock<T>(file: string, write: () => T, waitMs = LOCK_WAIT_MS): T {
	const release = lockSessionFile(file, waitMs);
	try {
		return write();
	} finally {
		release();
	}
}

function readForeignEntries(state: SessionState, file: string, known: number, to: number): SessionEntry[] {
	// Read from one byte early so a `known` offset inside a record (a size taken while another writer was appending)
	// can be detected: that record's remainder is skipped, since the load read it whole or skips it by id.
	const from = Math.max(0, known - 1);
	const bytes = Buffer.allocUnsafe(to - from);
	const fd = openSync(file, "r");
	try {
		let read = 0;
		while (read < bytes.length) {
			const count = readSync(fd, bytes, read, bytes.length - read, from + read);
			if (count === 0) break;
			read += count;
		}
		if (read !== bytes.length) throw new Error("Session file changed while it was being read.");
	} finally {
		closeSync(fd);
	}
	if (bytes[bytes.length - 1] !== 10) {
		// Who wrote it is unknown here: another process, or an earlier one of this session that stopped mid-append.
		throw new Error(`Session has an incomplete final record. ${forkHint(file)}`);
	}
	const start = known === 0 ? 0 : bytes.indexOf(10) + 1;
	const lines: { at: number; line: JsonlLine }[] = [];
	for (let at = start; at < bytes.length;) {
		const end = bytes.indexOf(10, at);
		// A newline byte never occurs inside a UTF-8 character: each line decodes on its own.
		const line = parseJsonlLine(bytes.toString("utf8", at, end));
		if (line) lines.push({ at, line });
		at = end + 1;
	}
	const entries: SessionEntry[] = [];
	// Unlike a load, which skips a torn line, a merge refuses any record it cannot place: skipping would drop another
	// process's entry from this state and then from the file. The one exception is a line a later write sealed under the
	// lock (`session-tail.ts`): the recovery record right after it names its exact bytes.
	for (const [index, { at, line }] of lines.entries()) {
		if (!line.ok) {
			const next = lines[index + 1]?.line;
			const end = bytes.indexOf(10, at);
			if (next?.ok && sealsLine(next.value, from + at, end - at)) continue;
			throw new Error(`Session has a malformed record written by another process. ${forkHint(file)}`);
		}
		const record = line.value as { type?: unknown; id?: unknown } | null;
		if (typeof record !== "object" || record === null || typeof record.type !== "string") {
			throw new Error(`Session has an unrecognized record written by another process. ${forkHint(file)}`);
		}
		if (record.type === "session") continue;
		if (typeof record.id !== "string") {
			throw new Error(`Session has a record without an id written by another process. ${forkHint(file)}`);
		}
		// Stored against the lines before it, which this state's codec has read or written (`codec.ts`).
		entries.push(state.codec.decode(record as SessionEntry));
	}
	return entries;
}

/**
 * Bring this state level with the file, which the caller has locked. Records another process appended are added
 * to `fileEntries` (before `pending`, matching file order) and to the indexes, never to `leafId`. A `pending` entry with
 * the id of a foreign record gets a fresh id. Throws when the file shrank or the new bytes are not whole records. `to`: a
 * line start to stop at (the start of a cut-off last line, `session-tail.ts`); the file's end by default.
 */
export function mergeForeignEntries(
	state: SessionState,
	file: string,
	pending: readonly SessionEntry[] = [],
	to = statSync(file).size,
): void {
	const size = to;
	const known = state.fileSize;
	if (known === undefined) {
		state.fileSize = size;
		return;
	}
	if (size === known) return;
	if (size < known) {
		throw new Error(`Session file shrank from ${known} to ${size} bytes; another process rewrote it.`);
	}
	const pendingIndex = pending.length > 0 ? state.fileEntries.lastIndexOf(pending[0]) : -1;
	for (const entry of pending) state.byId.delete(entry.id);
	// Records this state already holds (read by the load, or re-read after another process rewrote the file) are skipped.
	const foreign = readForeignEntries(state, file, known, size).filter((entry) => !state.byId.has(entry.id));
	for (const entry of foreign) indexSessionEntry(entry, state.byId, state.labelsById, state.labelTimestampsById);
	state.fileEntries.splice(pendingIndex === -1 ? state.fileEntries.length : pendingIndex, 0, ...foreign);
	for (const entry of pending) {
		if (state.byId.has(entry.id)) reassignEntryId(state, entry, pending);
		state.byId.set(entry.id, entry);
	}
	state.fileSize = size;
}

function reassignEntryId(state: SessionState, entry: SessionEntry, pending: readonly SessionEntry[]): void {
	const oldId = entry.id;
	entry.id = generateId(state.byId);
	if (entry.type === "compaction" && entry.firstKeptEntryId === oldId) entry.firstKeptEntryId = entry.id;
	if (state.leafId === oldId) state.leafId = entry.id;
	// A held entry can be the parent of the next one in the same write.
	for (const child of pending) if (child.parentId === oldId) child.parentId = entry.id;
}
