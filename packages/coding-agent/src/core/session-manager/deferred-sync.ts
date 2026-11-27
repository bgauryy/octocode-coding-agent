/**
 * Syncs appended session records to the disk off the main thread.
 *
 * An append used to end in a synchronous `fsync` (`appendFileSync(..., { flush: true })`). On macOS that call waits
 * for the drive and took about 2 of every 7 seconds of a busy run in a profile, with the terminal unable to read a
 * key or paint a scroll while it waited. The write itself still happens before `appendEntry` returns, so the record
 * is in the operating system's cache at once: a crash of this process loses nothing, and another process reads the
 * new record immediately. Only the wait for the drive moves here. The sync waits for the session to go quiet: it runs
 * `SYNC_IDLE_MS` after the last append, and at most `SYNC_MAX_DELAY_MS` after the first unsynced one, so a burst of
 * appends costs one `fsync` and none of them waits for one (an `fsync` running on APFS delays the next append's lock
 * directory). A process that exits syncs what is still unsynced (`syncPendingSessions`). A power loss or kernel crash
 * inside that window can lose those last records or leave part of one at the end of the file; nothing is cut then
 * either: the next append seals that part as a line every reader skips and records where it is (`session-tail.ts`). A
 * rewrite or a new file (fork) is synced by its own write, as before.
 *
 * A sync that fails (a full disk, an I/O error, a network file system) must not stay silent: the synchronous flush
 * used to raise it inside the append. The file is then marked (`sessionSyncFailed`), and the next append to it flushes
 * synchronously again, so the same error surfaces through the append's own failure path. A flush that succeeds clears
 * the mark (`sessionSyncRecovered`).
 */

import { close, closeSync, fsync, fsyncSync, open, openSync } from "node:fs";

/** Quiet time after the last append before the sync runs. */
const SYNC_IDLE_MS = 250;
/** Longest an appended record waits for its sync while appends keep coming. */
const SYNC_MAX_DELAY_MS = 1000;

const waiting = new Map<string, { timer: NodeJS.Timeout; deadline: number }>();
const running = new Set<string>();
const again = new Set<string>();
const failed = new Set<string>();

/** Whether the last deferred sync of `file` failed: its next append must flush synchronously to surface the error. */
export const sessionSyncFailed = (file: string): boolean => failed.has(file);

/** A synchronous flush of `file` succeeded: deferred syncs may be used again. */
export function sessionSyncRecovered(file: string): void {
	failed.delete(file);
}

function sync(file: string): void {
	if (running.has(file)) {
		again.add(file);
		return;
	}
	running.add(file);
	const done = () => {
		running.delete(file);
		if (again.delete(file)) scheduleSessionSync(file);
	};
	// A file that is gone (a removed session, a test's temporary folder) has nothing left to sync.
	open(file, "r+", (openError, fd) => {
		if (openError) {
			if (openError.code === "ENOENT") failed.delete(file);
			else failed.add(file);
			return done();
		}
		fsync(fd, (syncError) => {
			if (syncError) failed.add(file);
			else failed.delete(file);
			close(fd, (closeError) => {
				if (closeError) failed.add(file);
				done();
			});
		});
	});
}

/** Ask for `file` to be synced once appends to it pause (`SYNC_IDLE_MS`, at most `SYNC_MAX_DELAY_MS`). Returns at once; never throws. */
export function scheduleSessionSync(file: string): void {
	const now = Date.now();
	const pending = waiting.get(file);
	const deadline = pending?.deadline ?? now + SYNC_MAX_DELAY_MS;
	if (pending) clearTimeout(pending.timer);
	const timer = setTimeout(
		() => {
			waiting.delete(file);
			sync(file);
		},
		Math.max(0, Math.min(SYNC_IDLE_MS, deadline - now)),
	);
	// The process may end before the timer: the exit hook syncs what is still waiting.
	timer.unref();
	waiting.set(file, { timer, deadline });
	watchExit();
}

/**
 * Sync now, on this thread, every file with appends not yet synced (waiting, running, or a previous sync failed). For
 * the moment the process exits; never throws.
 */
export function syncPendingSessions(): void {
	const files = new Set([...waiting.keys(), ...running, ...failed]);
	for (const [file, pending] of waiting) {
		clearTimeout(pending.timer);
		waiting.delete(file);
	}
	for (const file of files) {
		try {
			const fd = openSync(file, "r+");
			try {
				fsyncSync(fd);
				failed.delete(file);
			} finally {
				closeSync(fd);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") failed.delete(file);
			else failed.add(file);
			// Gone, or not syncable: the records were written; the system flushes them.
		}
	}
}

let exitWatched = false;
function watchExit(): void {
	if (exitWatched) return;
	exitWatched = true;
	process.once("exit", syncPendingSessions);
}
