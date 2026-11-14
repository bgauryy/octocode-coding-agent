import fs from "node:fs/promises";
import lockfile from "proper-lockfile";
import { processStartTime, sameProcessAsync } from "../shared/process.ts";

/** A lock whose mtime is older than this is taken over even when its owner cannot be identified (no owner file). */
const STALE_MS = 30_000;
/** How long a caller waits for a live owner before giving up. */
const LOCK_WAIT_MS = 8500;

interface LockOwner {
	pid: number;
	pid_started: string | undefined;
	/** Inode of the lock directory this owner created; a takeover after `STALE_MS` creates a new directory. */
	dir?: string;
}

async function lockDirId(lockPath: string): Promise<string | undefined> {
	try {
		return String((await fs.stat(`${lockPath}.lock`, { bigint: true })).ino);
	} catch {
		return undefined;
	}
}

function ownerPath(lockPath: string): string {
	return `${lockPath}.owner`;
}

function mutexPath(lockPath: string): string {
	return `${lockPath}.break`;
}

function isLocked(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === "ELOCKED";
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(ownerPath(lockPath), "utf8"));
		const owner = parsed as LockOwner;
		if (
			typeof owner?.pid === "number" &&
			(owner.pid_started === undefined || typeof owner.pid_started === "string") &&
			(owner.dir === undefined || typeof owner.dir === "string")
		)
			return owner;
	} catch {
		// No owner file, or one being written: the owner is unknown.
	}
	return undefined;
}

/**
 * Removes the lock when its recorded owner process is gone, and reports whether it did. Breakers take turns on a
 * second lock and re-read the owner under it: the lock directory can then only be replaced by a breaker, so one that
 * saw a dead owner never removes a lock a new owner took in between. The owner file goes first, so a new owner cannot
 * write its own before the old directory is gone.
 */
async function breakDeadOwner(lockPath: string): Promise<boolean> {
	const owner = await readOwner(lockPath);
	if (!owner || (await sameProcessAsync(owner.pid, owner.pid_started))) return false;
	let release: (() => Promise<void>) | undefined;
	// A breaker stalled past the mutex's stale limit may have lost it to another breaker: it then removes nothing.
	let compromised = false;
	try {
		release = await lockfile.lock(mutexPath(lockPath), {
			realpath: false,
			stale: 5000,
			retries: { retries: 40, factor: 1, minTimeout: 25, maxTimeout: 50 },
			onCompromised: () => {
				compromised = true;
			},
		});
	} catch {
		return false;
	}
	try {
		const current = await readOwner(lockPath);
		if (!current || current.pid !== owner.pid || current.pid_started !== owner.pid_started) return false;
		// A waiter may have taken the lock over through proper-lockfile's stale path before writing its own owner file;
		// the dead owner's record then describes a directory that no longer exists.
		if (current.dir !== undefined && current.dir !== (await lockDirId(lockPath))) return false;
		if (compromised) return false;
		await fs.rm(ownerPath(lockPath), { force: true });
		await fs.rmdir(`${lockPath}.lock`).catch(() => undefined);
		return true;
	} finally {
		await release().catch(() => undefined);
	}
}

/** Releases a registry lock; `assertHeld` throws the compromise error once another process took the lock over. */
export type RegistryLockRelease = (() => Promise<void>) & { assertHeld(): void };

interface RegistryLockOptions {
	/**
	 * Called once when the lock is compromised: this process stalled past the stale limit (system sleep, a blocked event
	 * loop) and another may own it now. A guarded operation must stop; a lifetime holder must shut down.
	 */
	onCompromised?: (error: Error) => void;
	/** The stale limit; tests shorten it (proper-lockfile's minimum is 2s). */
	staleMs?: number;
}

/**
 * Takes the registry lock, waiting up to `waitMs` for a live owner. The owner's pid is recorded beside the lock, so a
 * lock left by a crashed process is broken at once instead of after `STALE_MS`; a lock without a readable owner still
 * goes stale after `STALE_MS`. A compromised lock is never released over its successor: the release then removes
 * neither the lock nor the owner file.
 */
export async function acquireRegistryLock(
	lockPath: string,
	waitMs = LOCK_WAIT_MS,
	options: RegistryLockOptions = {},
): Promise<RegistryLockRelease> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			let compromised: Error | undefined;
			const release = await lockfile.lock(lockPath, {
				realpath: false,
				stale: options.staleMs ?? STALE_MS,
				retries: 0,
				onCompromised: (error) => {
					compromised = error;
					options.onCompromised?.(error);
				},
			});
			const dir = await lockDirId(lockPath);
			const owner: LockOwner = {
				pid: process.pid,
				pid_started: processStartTime(process.pid),
				...(dir === undefined ? {} : { dir }),
			};
			await fs.writeFile(ownerPath(lockPath), JSON.stringify(owner)).catch(() => undefined);
			const assertHeld = () => {
				if (compromised) throw compromised;
			};
			return Object.assign(
				async () => {
					// The owner file and lock directory may be a successor's now.
					if (compromised) return;
					await fs.rm(ownerPath(lockPath), { force: true }).catch(() => undefined);
					await release();
				},
				{ assertHeld },
			);
		} catch (error) {
			if (!isLocked(error)) throw error;
			if (await breakDeadOwner(lockPath)) continue;
			if (Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 50));
		}
	}
}
