import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { forkHint, withSessionFileLock } from "./shared-file.ts";
import type { FailedWrite, SessionState } from "./state.ts";

/**
 * Getting a session writable again after a failed write, without removing a byte. A full disk or an I/O error is not a
 * verdict on the file: once a later write can reach it, the session goes on. A process that tore the tail itself knows
 * exactly what it was writing, so it can seal that fragment with a newline: the fragment stays on disk as a malformed
 * line the loader skips. A tail this process cannot prove is its own stays refused by the normal write path, and so does
 * a file whose contents were refused (it shrank, or holds a record that cannot be placed).
 */

function readRange(file: string, from: number, to: number): Buffer {
	const bytes = Buffer.alloc(Math.max(0, to - from));
	const fd = openSync(file, "r");
	try {
		const read = readSync(fd, bytes, 0, bytes.length, from);
		return bytes.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

/** With the session lock held: end what this state's failed append left, when the bytes past `from` are provably that. */
function sealOwnTail(state: SessionState, file: string, failed: FailedWrite): void {
	if (failed.line === undefined || failed.from === undefined) return;
	const size = statSync(file).size;
	// Still under the lock the failure held: any change since is another writer's, so that tail is not provably ours.
	if (failed.after === undefined || size !== failed.after) return;
	const line = Buffer.from(failed.line);
	const written = readRange(file, failed.from, size);
	if (written.length === 0 || written.length > line.length) return;
	if (!written.equals(line.subarray(0, written.length))) return;
	const sealed = written.at(-1) !== 10;
	if (sealed) appendFileSync(file, "\n", { flush: true });
	const end = size + (sealed ? 1 : 0);
	// Only the newline, or nothing, was missing: the record itself landed, and only its flush failed.
	const landed = written.length >= line.length - 1;
	const held = failed.entry ? state.unwritten.indexOf(failed.entry) : -1;
	if (landed && held >= 0) state.unwritten.splice(held, 1);
	// A landed record that was rolled back comes back through the next merge, like any record this state has not seen;
	// a fragment is stepped over, since a merge refuses what it cannot parse.
	state.fileSize = landed && held < 0 ? failed.from : end;
}

/**
 * Before a write: throws the failure that blocks writes unless it can be lifted. A failed attempt to seal, or a first
 * write that left a partial file behind, leaves the block as it was.
 */
export function liftWriteBlock(state: SessionState): void {
	const blocked = state.persistenceFailure;
	if (!blocked) return;
	const { failedWrite: failed, sessionFile: file } = state;
	if (!failed || !file) throw blocked;
	if (!state.flushed && existsSync(file)) throw blocked;
	try {
		if (state.flushed) withSessionFileLock(file, () => sealOwnTail(state, file, failed));
	} catch {
		throw blocked;
	}
	state.failedWrite = undefined;
	state.persistenceFailure = undefined;
}

/** The failure that blocks writes after `error`, which is recorded as liftable when it came from the file system. */
export function blockWrites(state: SessionState, error: unknown): Error {
	const code = (error as { code?: unknown } | null)?.code;
	if (!state.failedWrite && typeof code === "string") state.failedWrite = { from: state.fileSize };
	const cause = String(error);
	const hint = state.sessionFile && !cause.includes("--fork") ? ` ${forkHint(state.sessionFile)}` : "";
	const next = state.failedWrite ? "The next write tries again." : "Further writes are blocked.";
	state.persistenceFailure = new Error(`Session persistence failed: ${cause}. ${next}${hint}`, { cause: error });
	return state.persistenceFailure;
}
