/**
 * Lock-guarded storage backends for auth.json content: the file backend and an in-memory one for tests and SDK hosts.
 */

import type { AuthOperationOptions, Credential } from "@octocodeai/octocode-ai";
import { raceWithAbortSignal } from "@octocodeai/octocode-ai/utils/abort";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgentDir } from "../../config.ts";
import { atomicWriteFileSync } from "../../../../common/src/atomic-file.ts";
import { lockSyncWithRetry } from "../../../../common/src/file-write-lock.ts";
import { normalizePath } from "../../../../common/src/paths.ts";

export type AuthStorageData = Record<string, Credential>;

// On Windows, a just-removed lock directory can stay "delete pending" while another process
// (antivirus, indexer, another Octocode process checking the lock) still has it open. mkdir then fails with
// EPERM until that handle closes. Retry this briefly so real permission errors still fail fast.
const MAX_EPERM_RETRIES = 5;

function getRetryableLockErrorCode(error: unknown): "ELOCKED" | "EPERM" | undefined {
	const code = error instanceof Error && "code" in error ? error.code : undefined;
	if (code === "ELOCKED") return code;
	if (code === "EPERM" && process.platform === "win32") return code;
	return undefined;
}

export type LockResult<T> = {
	result: T;
	next?: string;
};

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

/**
 * Replace the file whole (temp file, fsync, rename): a crash leaves the old or the new content, never a torn file.
 * A credential file is always private (0600), so one an older build or a person left at 0644 is tightened on the next
 * write; a file without secrets (`keepMode`) keeps an existing file's mode (administrator-managed modes and ACLs).
 */
function writeAuthFile(path: string, next: string, keepMode: boolean): void {
	atomicWriteFileSync(path, next, keepMode && existsSync(path) ? {} : { mode: 0o600 });
}

/** What the store held when an async operation failed, read under the same lock; `unreadable` when it could not be read. */
export type LockFailureState = { content: string | undefined } | "unreadable";

/**
 * Runs while the lock is still held, after `fn`, the write or a lock check failed, so compensation (undoing an outside
 * write) cannot interleave with another writer. Its own errors are ignored here: the handler records what it needs.
 */
export type LockFailureHandler = (state: LockFailureState) => Promise<void>;

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
		onFailure?: LockFailureHandler,
	): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;
	/** Set for files without secrets (the models cache): an existing file keeps its mode instead of being tightened. */
	private readonly keepMode: boolean;

	constructor(authPath: string = join(getAgentDir(), "auth.json"), options: { keepMode?: boolean } = {}) {
		this.authPath = normalizePath(authPath);
		this.keepMode = options.keepMode ?? false;
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			try {
				// Another process may create its credentials before this process obtains the lock.
				writeFileSync(this.authPath, "{}", { ...AUTH_FILE_WRITE_OPTIONS, flag: "wx" });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = lockSyncWithRetry(this.authPath, {
				retryable: (error) => getRetryableLockErrorCode(error) !== undefined,
			});
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeAuthFile(this.authPath, next, this.keepMode);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	private async acquireLockAsync(
		signal: AbortSignal | undefined,
		onCompromised: (error: Error) => void,
	): Promise<() => Promise<void>> {
		const staleMs = 30_000;
		const maxDelayMs = 2_000;
		const deadline = Date.now() + staleMs;
		let retry = 0;
		let epermRetries = 0;
		while (true) {
			signal?.throwIfAborted();
			let release: (() => Promise<void>) | undefined;
			try {
				release = await lockfile.lock(this.authPath, {
					realpath: false,
					retries: 0,
					stale: staleMs,
					onCompromised,
				});
			} catch (error) {
				signal?.throwIfAborted();
				const code = getRetryableLockErrorCode(error);
				const remainingMs = deadline - Date.now();
				if (!code || remainingMs <= 0) throw error;
				// The 30s deadline is for waiting on another holder; cap EPERM retries separately.
				if (code === "EPERM" && ++epermRetries > MAX_EPERM_RETRIES) throw error;
				const baseDelayMs = Math.min(10 * 2 ** retry, maxDelayMs / 2);
				retry++;
				const delayMs = Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs);
				if (signal) await sleep(delayMs, undefined, { signal });
				else await sleep(delayMs);
				continue;
			}
			if (signal?.aborted) {
				await release();
				signal.throwIfAborted();
			}
			return release;
		}
	}

	/** Reads the file as it is now and hands it to `handler`; the caller still holds the lock. */
	private async runFailureHandler(handler: LockFailureHandler): Promise<void> {
		let state: LockFailureState;
		try {
			state = { content: existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined };
		} catch {
			state = "unreadable";
		}
		try {
			await handler(state);
		} catch {
			// The handler records its own outcome; the original failure is the one to report.
		}
	}

	async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
		onFailure?: LockFailureHandler,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await this.acquireLockAsync(options?.signal, (error) => {
				lockCompromised = true;
				lockCompromisedError = error;
			});

			throwIfCompromised();
			options?.signal?.throwIfAborted();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			try {
				const { result, next } = await fn(current);
				throwIfCompromised();
				options?.signal?.throwIfAborted();
				if (next !== undefined) {
					writeAuthFile(this.authPath, next, this.keepMode);
				}
				throwIfCompromised();
				return result;
			} catch (error) {
				if (onFailure) await this.runFailureHandler(onFailure);
				throw error;
			}
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private asyncChain: Promise<unknown> = Promise.resolve();

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthOperationOptions,
		onFailure?: LockFailureHandler,
	): Promise<T> {
		const previous = this.asyncChain;
		const operation = (async () => {
			await previous.catch(() => {});
			options?.signal?.throwIfAborted();
			try {
				const { result, next } = await fn(this.value);
				options?.signal?.throwIfAborted();
				if (next !== undefined) {
					this.value = next;
				}
				return result;
			} catch (error) {
				await onFailure?.({ content: this.value }).catch(() => {});
				throw error;
			}
		})();
		this.asyncChain = operation.catch(() => {});
		return raceWithAbortSignal(operation, options?.signal);
	}
}
