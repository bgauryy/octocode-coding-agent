import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { canonicalPath } from "../../../../common/src/canonical-path.ts";
import { jsonlLines } from "../../../../common/src/jsonl.ts";
import { generateId } from "./entries.ts";
import type { SessionState } from "./state.ts";
import { indexSessionEntry } from "./tree.ts";
import type { SessionEntry } from "./types.ts";

// Another octocode process can continue the same session file. Every write runs under a short lock on the file,
// and foreign records appended since this state's last write are merged into memory first. A file that shrank or
// ends in a partial record is never written to.

/** Longest a write waits for another process's lock; the holder keeps it for a few milliseconds. */
const LOCK_WAIT_MS = 3000;

function pause(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take `<file>.lock`, polling with a short randomized sleep so two writers appending back to back cannot starve
 * each other the way fixed-interval polling can. Throws the lock error after `LOCK_WAIT_MS`.
 */
function acquireSessionLock(file: string): () => void {
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			return lockfile.lockSync(file, { realpath: false, lockfilePath: `${file}.lock` });
		} catch (error) {
			const held = (error as { code?: unknown } | null)?.code === "ELOCKED";
			if (!held || Date.now() >= deadline) throw error;
			pause(1 + Math.random() * 6);
		}
	}
}

/** Whether `error` is a lock another process held past `LOCK_WAIT_MS`; nothing was written, so the write may be retried. */
export function isSessionLockTimeout(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === "ELOCKED";
}

/** Run `write` while holding the cross-process lock `<file>.lock`. A failed release is ignored: the lock goes stale and is reclaimed. */
export function withSessionFileLock<T>(file: string, write: () => T): T {
	// A new session may belong to a folder that does not exist yet (the workspace folder, for a session opened from the legacy one).
	mkdirSync(dirname(file), { recursive: true });
	const release = acquireSessionLock(canonicalPath(file));
	try {
		return write();
	} finally {
		try {
			release();
		} catch {
			// The write already succeeded or failed on its own terms.
		}
	}
}

function readForeignEntries(file: string, known: number, to: number): SessionEntry[] {
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
		throw new Error("Session has an incomplete final record written by another process; recover the transcript.");
	}
	const start = known === 0 ? 0 : bytes.indexOf(10) + 1;
	const entries: SessionEntry[] = [];
	// Unlike a load, which skips a torn line, a merge refuses any record it cannot place: skipping would drop another
	// process's entry from this state and then from the file.
	for (const line of jsonlLines(bytes.subarray(start).toString("utf8"))) {
		if (!line.ok) {
			throw new Error("Session has a malformed record written by another process; recover the transcript.");
		}
		const record = line.value as { type?: unknown; id?: unknown } | null;
		if (typeof record !== "object" || record === null || typeof record.type !== "string") {
			throw new Error("Session has an unrecognized record written by another process; recover the transcript.");
		}
		if (record.type === "session") continue;
		if (typeof record.id !== "string") {
			throw new Error("Session has a record without an id written by another process; recover the transcript.");
		}
		entries.push(record as SessionEntry);
	}
	return entries;
}

/**
 * Bring this state level with the file, which the caller has locked. Records another process appended are added
 * to `fileEntries` (before `pending`, matching file order) and to the indexes, never to `leafId`. When `pending` has
 * the id of a foreign record it gets a fresh id. Throws when the file shrank or the new bytes are not whole records.
 */
export function mergeForeignEntries(state: SessionState, file: string, pending?: SessionEntry): void {
	const size = statSync(file).size;
	const known = state.fileSize;
	if (known === undefined) {
		state.fileSize = size;
		return;
	}
	if (size === known) return;
	if (size < known) {
		throw new Error(`Session file shrank from ${known} to ${size} bytes; another process rewrote it.`);
	}
	const pendingIndex = pending ? state.fileEntries.lastIndexOf(pending) : -1;
	if (pending) state.byId.delete(pending.id);
	// Records this state already holds (read by the load, or re-read after another process rewrote the file) are skipped.
	const foreign = readForeignEntries(file, known, size).filter((entry) => !state.byId.has(entry.id));
	for (const entry of foreign) indexSessionEntry(entry, state.byId, state.labelsById, state.labelTimestampsById);
	state.fileEntries.splice(pendingIndex === -1 ? state.fileEntries.length : pendingIndex, 0, ...foreign);
	if (pending) {
		if (state.byId.has(pending.id)) reassignEntryId(state, pending);
		state.byId.set(pending.id, pending);
	}
	state.fileSize = size;
}

function reassignEntryId(state: SessionState, entry: SessionEntry): void {
	const oldId = entry.id;
	entry.id = generateId(state.byId);
	if (entry.type === "compaction" && entry.firstKeptEntryId === oldId) entry.firstKeptEntryId = entry.id;
	if (state.leafId === oldId) state.leafId = entry.id;
}
