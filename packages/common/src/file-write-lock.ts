import { createHash } from "node:crypto";
import fs from "node:fs";
import { readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";

export class FileLockReleaseError extends Error {
	readonly mutationCompleted = true;
	constructor(file: string, cause: unknown) {
		super(
			`The file mutation completed, but its lock could not be released: ${file}. Inspect the file before retrying.`,
			{ cause },
		);
	}
}

const SYNC_LOCK_ATTEMPTS = 10;
const SYNC_LOCK_RETRY_DELAY_MS = 20;

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
	const attempts = options.attempts ?? SYNC_LOCK_ATTEMPTS;
	for (let attempt = 1; ; attempt++) {
		try {
			return lockfile.lockSync(file, { realpath: false, lockfilePath: options.lockfilePath, ...options.lockOptions });
		} catch (error) {
			if (!retryable(error) || attempt >= attempts) throw error;
			// Callers stay synchronous: block the thread without spinning the CPU.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, SYNC_LOCK_RETRY_DELAY_MS);
		}
	}
}

/** The lock directory's identity: a takeover by another process removes it and creates a new one. */
function lockIdentity(lockfilePath: string): string | undefined {
	const stat = fs.statSync(lockfilePath, { bigint: true, throwIfNoEntry: false });
	return stat ? `${stat.dev}:${stat.ino}:${stat.mtimeNs}` : undefined;
}

/**
 * Run the synchronous `update` holding `file`'s `proper-lockfile` lock (`lockfilePath`, default `<file>.lock`). Waiters
 * retry for about `attempts` × 20ms and then fail with `ELOCKED`; they never break a live holder's lock. A lock whose
 * holder stalled past `proper-lockfile`'s stale limit (10s; a synchronous holder cannot refresh it) may be taken over:
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
	const held = () => lock.owned !== undefined && lockIdentity(lockfilePath) === lock.owned;
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
	lock.owned = lockIdentity(lockfilePath);
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
	while (!release) {
		signal?.throwIfAborted();
		try {
			release = await lockfile.lock(target, {
				realpath: false,
				lockfilePath: path.join(path.dirname(target), `.octocode-${key}.lock`),
				stale: 30_000,
				retries: 0,
				onCompromised: (error) => {
					compromised = error;
				},
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
			await sleep(50, undefined, { signal });
		}
	}
	const assertHeld = () => {
		signal?.throwIfAborted();
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
