import { mkdirSync, rmSync, statSync } from "node:fs";

export interface LockTimings {
	/** A lock older than this was left by a holder that died, and is broken. Default 10000. */
	staleMs?: number;
	/** Stop waiting and throw after this long. Default 30000. */
	timeoutMs?: number;
}

const pause = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms: number): void => void Atomics.wait(pause, 0, 0, ms);

/** Milliseconds since `path` was created or touched; 0 when it is gone (so it is never stale). */
function age(path: string): number {
	const s = statSync(path, { throwIfNoEntry: false });
	return s ? Date.now() - s.mtimeMs : 0;
}

/** `mkdir` as test-and-set: true when this call created `dir`. Any failure but "exists" throws. */
function take(dir: string): boolean {
	try {
		mkdirSync(dir);
		return true;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw new Error(`cannot create lock ${dir}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
	}
}

/**
 * Removes `lock` when it is stale. Breakers take a second directory first and check the age again while holding it,
 * so a fresh lock taken after the stale one was removed is never removed too.
 */
function breakStale(lock: string, staleMs: number): void {
	if (age(lock) < staleMs) return;
	const guard = `${lock}.break`;
	if (!take(guard)) {
		if (age(guard) >= staleMs) rmSync(guard, { recursive: true, force: true });
		return;
	}
	try {
		if (age(lock) >= staleMs) rmSync(lock, { recursive: true, force: true });
	} finally {
		rmSync(guard, { recursive: true, force: true });
	}
}

/**
 * Runs `fn` holding a lock shared by every process on this machine: the directory `lock`, created atomically.
 * Waiters poll it; a stale lock is broken; a wait longer than `timeoutMs` throws naming the lock.
 */
export function withFileLock<T>(lock: string, fn: () => T, timings: LockTimings = {}): T {
	const { staleMs = 10_000, timeoutMs = 30_000 } = timings;
	const deadline = Date.now() + timeoutMs;
	for (let wait = 1; !take(lock); wait = Math.min(wait * 2, 50)) {
		breakStale(lock, staleMs);
		if (Date.now() >= deadline)
			throw new Error(`lock ${lock} is still held after ${timeoutMs} ms; remove it if no test run is using it`);
		sleep(wait);
	}
	try {
		return fn();
	} finally {
		rmSync(lock, { recursive: true, force: true });
	}
}
