import { createHash } from "node:crypto";
import fs from "node:fs";
import { readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { guardLockOwner } from "./lock-owner.ts";

export class FileLockReleaseError extends Error {
	readonly mutationCompleted = true;
	constructor(file: string, cause: unknown) {
		super(
			`The file mutation completed, but its lock could not be released: ${file}. Inspect the file before retrying.`,
			{ cause },
		);
	}
}

/** How often a waiter tries a held lock, and the pause between tries: about 200ms in all. */
export const LOCK_ATTEMPTS = 10;
export const LOCK_RETRY_DELAY_MS = 20;

function isLockHeld(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ELOCKED";
}

/**
 * Take a `proper-lockfile` lock synchronously, retrying briefly while another process holds it. Callers stay
 * synchronous, so the wait between attempts blocks. `retryable` decides which errors are worth another attempt.
 */
export function lockSyncWithRetry(
	file: string,
	options: {
		lockfilePath?: string;
		retryable?: (error: unknown) => boolean;
		attempts?: number;
		/** Passed to `proper-lockfile`: its file system (`withFileLockSync` guards removal) and compromise handler. */
		lockOptions?: Pick<lockfile.LockOptions, "fs" | "onCompromised">;
	} = {},
): () => void {
	const retryable = options.retryable ?? isLockHeld;
	const attempts = options.attempts ?? LOCK_ATTEMPTS;
	const lockfilePath = options.lockfilePath ?? `${path.resolve(file)}.lock`;
	for (let attempt = 1; ; attempt++) {
		try {
			const guard = guardLockOwner(lockfilePath, options.lockOptions?.fs ?? fs);
			guard.check();
			const release = lockfile.lockSync(file, {
				realpath: false,
				lockfilePath,
				...options.lockOptions,
				fs: guard.fs,
			});
			const forget = guard.acquired();
			return () => {
				try {
					release();
				} finally {
					forget();
				}
			};
		} catch (error) {
			if (!retryable(error) || attempt >= attempts) throw error;
			// Callers stay synchronous: block the thread without spinning the CPU.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_DELAY_MS);
		}
	}
}

/**
 * The lock directory's identity: a takeover by another process removes it and creates a new one. Its modification time
 * counts too when `withMtime` (a synchronous holder, which never refreshes it): a new directory that reuses the inode
 * still differs. A heartbeat changes ctime too, so it is never part of the identity.
 */
function lockIdentity(stat: fs.BigIntStats | undefined, withMtime = false): string | undefined {
	return stat ? `${stat.dev}:${stat.ino}${withMtime ? `:${stat.mtimeNs}` : ""}` : undefined;
}

const syncLockIdentity = (lockfilePath: string) =>
	lockIdentity(fs.statSync(lockfilePath, { bigint: true, throwIfNoEntry: false }), true);

/**
 * Run the synchronous `update` holding `file`'s `proper-lockfile` lock (`lockfilePath`, default `<file>.lock`). Waiters
 * retry for about `attempts` × 20ms and then fail with `ELOCKED`; a matching owner record protects a stalled live holder.
 * A legacy holder without a matching record may be taken over after `proper-lockfile`'s stale limit (10s):
 * `assertHeld` then throws `ECOMPROMISED`, so call it right before writing, and the release leaves the successor's lock
 * in place instead of removing it.
 */
export function withFileLockSync<T>(
	file: string,
	update: (assertHeld: () => void) => T,
	options: { lockfilePath?: string; attempts?: number } = {},
): T {
	const lockfilePath = options.lockfilePath ?? `${path.resolve(file)}.lock`;
	// Unset while acquiring: a stale lock removed then is not ours to guard.
	const lock: { owned?: string } = {};
	const held = () => lock.owned !== undefined && syncLockIdentity(lockfilePath) === lock.owned;
	const guardedFs = {
		...fs,
		// Release (and the exit cleanup) removes the lock only while it is still the directory this holder created.
		rmdirSync: (target: fs.PathLike, ...rest: [fs.RmDirOptions?]) => {
			if (lock.owned !== undefined && String(target) === lockfilePath && !held()) return;
			fs.rmdirSync(target, ...rest);
		},
	};
	const release = lockSyncWithRetry(file, {
		lockfilePath,
		attempts: options.attempts,
		// The refresh timer that reports a compromise cannot run during a synchronous hold; `held` checks the lock instead.
		lockOptions: { fs: guardedFs, onCompromised: () => {} },
	});
	lock.owned = syncLockIdentity(lockfilePath);
	const assertHeld = () => {
		if (!held())
			throw Object.assign(new Error(`Another process took over the lock on ${file}; nothing was written.`), {
				code: "ECOMPROMISED",
			});
	};
	try {
		return update(assertHeld);
	} finally {
		release();
	}
}

const lockDirectory = async (lockfilePath: string) =>
	lockIdentity(await fs.promises.stat(lockfilePath, { bigint: true }).catch(() => undefined));

/**
 * `withFileLockSync` for an async `update`: the same `proper-lockfile` lock (`lockfilePath`, default `<file>.lock`), so
 * the two exclude each other across processes, taken without blocking the thread. One attempt: a held lock fails at
 * once with `ELOCKED` and the caller decides when to try again. While held, proper-lockfile keeps refreshing it, so a
 * waiter takes it over only after this holder stops (its stale limit, 10s). `assertHeld` throws `ECOMPROMISED` after a
 * takeover: call it right before writing.
 */
export async function withFileLock<T>(
	file: string,
	update: (assertHeld: () => Promise<void>) => Promise<T>,
	options: { lockfilePath?: string } = {},
): Promise<T> {
	const lockfilePath = options.lockfilePath ?? `${path.resolve(file)}.lock`;
	let compromised: Error | undefined;
	// Unset while acquiring: a stale lock removed then is not ours to guard.
	const lock: { owned?: string } = {};
	const ours = (target: fs.PathLike) => lock.owned === undefined || String(target) !== lockfilePath;
	// Release (and the exit cleanup) removes the lock only while it is still the directory this holder created.
	const guardedFs = {
		...fs,
		rmdir: (target: fs.PathLike, callback: (error: NodeJS.ErrnoException | null) => void) => {
			if (ours(target)) return fs.rmdir(target, callback);
			fs.stat(lockfilePath, { bigint: true }, (error, stat) => {
				if (!error && lockIdentity(stat) === lock.owned) fs.rmdir(target, callback);
				else callback(null);
			});
		},
		rmdirSync: (target: fs.PathLike, ...rest: [fs.RmDirOptions?]) => {
			if (
				!ours(target) &&
				lockIdentity(fs.statSync(lockfilePath, { bigint: true, throwIfNoEntry: false })) !== lock.owned
			)
				return;
			fs.rmdirSync(target, ...rest);
		},
	};
	const guard = guardLockOwner(lockfilePath, guardedFs);
	guard.check();
	const releaseLock = await lockfile.lock(file, {
		realpath: false,
		lockfilePath,
		retries: 0,
		fs: guard.fs,
		onCompromised: (error) => {
			compromised = error;
		},
	});
	let forget = () => {};
	const release = async () => {
		try {
			await releaseLock();
		} finally {
			forget();
		}
	};
	try {
		forget = await guard.acquiredAsync();
		guard.assertHeld();
		lock.owned = await lockDirectory(lockfilePath);
		guard.assertHeld();
		const owned = lock.owned;
		const assertHeld = async () => {
			guard.assertHeld();
			const current = await lockDirectory(lockfilePath);
			guard.assertHeld();
			if (!compromised && owned !== undefined && current === owned) return;
			throw Object.assign(new Error(`Another process took over the lock on ${file}; nothing was written.`), {
				code: "ECOMPROMISED",
			});
		};
		return await update(assertHeld);
	} finally {
		// A compromised lock is already released (and the directory is the successor's): nothing of ours to remove.
		await release().catch((error: unknown) => {
			if (!compromised) throw error;
		});
	}
}

async function writeTarget(file: string, hops = 40): Promise<string> {
	try {
		return await realpath(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const link = await readlink(file).catch((failure: NodeJS.ErrnoException) => {
			if (failure.code === "ENOENT" || failure.code === "EINVAL") return undefined;
			throw failure;
		});
		if (link !== undefined) {
			if (hops === 0) throw new Error(`Too many symbolic links: ${file}`, { cause: error });
			return writeTarget(path.resolve(path.dirname(file), link), hops - 1);
		}
		return path.join(await realpath(path.dirname(file)), path.basename(file));
	}
}

/** Serialize cooperating processes through the content check and mutation; shell/editor writes are not excluded. */
export async function withFileWriteLock<T>(
	file: string,
	mutate: (target: string, assertHeld: () => void) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	const target = await writeTarget(file);
	const key = createHash("sha256").update(target).digest("hex");
	const deadline = Date.now() + 30_000;
	let compromised: Error | undefined;
	let release: (() => Promise<void>) | undefined;
	let assertOwner = () => {};
	const lockfilePath = path.join(path.dirname(target), `.octocode-${key}.lock`);
	while (!release) {
		signal?.throwIfAborted();
		try {
			const guard = guardLockOwner(lockfilePath);
			guard.check();
			const releaseLock = await lockfile.lock(target, {
				realpath: false,
				lockfilePath,
				fs: guard.fs,
				stale: 30_000,
				retries: 0,
				onCompromised: (error) => {
					compromised = error;
				},
			});
			let forget = () => {};
			release = async () => {
				try {
					await releaseLock();
				} finally {
					forget();
				}
			};
			forget = await guard.acquiredAsync();
			guard.assertHeld();
			assertOwner = guard.assertHeld;
		} catch (error) {
			if (release) {
				await release().catch(() => undefined);
				release = undefined;
			}
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
			await sleep(50, undefined, { signal });
		}
	}
	const assertHeld = () => {
		signal?.throwIfAborted();
		assertOwner();
		if (compromised) throw compromised;
	};
	let result: T;
	try {
		assertHeld();
		result = await mutate(target, assertHeld);
	} catch (error) {
		try {
			await release();
		} catch {
			// A failed mutation reports its own error, not a release failure.
		}
		throw error;
	}
	try {
		await release();
	} catch (error) {
		throw new FileLockReleaseError(file, error);
	}
	return result;
}
