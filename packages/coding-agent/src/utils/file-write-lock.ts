import { createHash } from "node:crypto";
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
	options: { lockfilePath?: string; retryable?: (error: unknown) => boolean } = {},
): () => void {
	const retryable = options.retryable ?? isLockHeld;
	for (let attempt = 1; ; attempt++) {
		try {
			return lockfile.lockSync(file, { realpath: false, lockfilePath: options.lockfilePath });
		} catch (error) {
			if (!retryable(error) || attempt === SYNC_LOCK_ATTEMPTS) throw error;
			const start = Date.now();
			while (Date.now() - start < SYNC_LOCK_RETRY_DELAY_MS) {
				// Sleep synchronously to avoid changing callers to async.
			}
		}
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
			if (hops === 0) throw new Error(`Too many symbolic links: ${file}`);
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
