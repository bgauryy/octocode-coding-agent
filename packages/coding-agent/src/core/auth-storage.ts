/**
 * CredentialStore implementation backed by auth.json.
 * Provider auth orchestration belongs to ModelRuntime and octocode-ai Models.
 */

import {
	isActiveCredential,
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
} from "@octocodeai/octocode-ai";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { raceWithAbortSignal } from "@octocodeai/octocode-ai/utils/abort";
import { getFileRevision, normalizePath } from "@octocodeai/octocode-common/paths";
import { stripBom } from "@octocodeai/octocode-common/text";
import { watchFileChanges } from "@octocodeai/octocode-common/watch-file";
import {
	type AuthStorageBackend,
	type AuthStorageData,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
	type LockFailureState,
} from "./auth-storage/backends.ts";
import { detectKeychain, type KeychainBackend } from "./auth-storage/keychain.ts";
import { resolveKeychainEndpointAsync } from "./auth-storage/keychain-endpoint.ts";
import {
	keepInKeychain,
	keychainEntry,
	resolveKeychainOAuth,
	resolveKeychainOAuthAsync,
} from "./auth-storage/keychain-oauth.ts";
import { resolveConfigValueAsync } from "./config-value.ts";
import { invalidEntryReason } from "./auth-storage/validation.ts";

export {
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
} from "./auth-storage/backends.ts";
export { ReadOnlyAuthStorage } from "./auth-storage/read-only.ts";

type AuthFileReload = {
	controller: AbortController;
	promise: Promise<AuthStorageData>;
	readers: number;
};

type AuthFileReadState = {
	data: AuthStorageData;
	revision?: string;
	reload?: AuthFileReload;
};

let sharedAuthFileReadState: { authPath: string; readState: AuthFileReadState } | undefined;

/** The credential an own key of `data` holds; a provider id such as `constructor` never reads an inherited property. */
function ownCredential(data: AuthStorageData, provider: string): Credential | undefined {
	return Object.hasOwn(data, provider) ? data[provider] : undefined;
}

/** What `auth.json` held for a provider when a guarded write failed; `unreadable` when it could not be read or parsed. */
export type HeldCredential = { credential: Credential | undefined } | "unreadable";

/** The `auth.json` entry was removed but its keychain entry could not be; `restored`: the entry was put back. */
export class KeychainReleaseError extends Error {
	readonly restored: boolean;
	constructor(restored: boolean) {
		super("The keychain entry could not be removed.");
		this.name = "KeychainReleaseError";
		this.restored = restored;
	}
}

export interface AuthStorageOptions {
	/** Keychain that holds keys referenced from auth.json; defaults to the platform keychain, detected on first use. */
	keychain?: KeychainBackend;
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage implements CredentialStore {
	private storage: AuthStorageBackend;
	private authPath: string | undefined;
	private readState: AuthFileReadState;
	private readonly options: AuthStorageOptions;

	private constructor(storage: AuthStorageBackend, authPath?: string, options: AuthStorageOptions = {}) {
		this.storage = storage;
		this.authPath = authPath;
		this.options = options;
		this.readState =
			authPath && sharedAuthFileReadState?.authPath === authPath ? sharedAuthFileReadState.readState : { data: {} };
		if (authPath && !sharedAuthFileReadState) {
			sharedAuthFileReadState = { authPath, readState: this.readState };
		}
		if (authPath) {
			const revision = getFileRevision(authPath);
			if (revision !== undefined && revision === this.readState.revision) return;
		}
		this.reload();
	}

	static create(authPath: string = join(getAgentDir(), "auth.json"), options?: AuthStorageOptions): AuthStorage {
		const normalizedAuthPath = normalizePath(authPath);
		return new AuthStorage(new FileAuthStorageBackend(normalizedAuthPath), normalizedAuthPath, options);
	}

	static fromStorage(storage: AuthStorageBackend, options?: AuthStorageOptions): AuthStorage {
		return new AuthStorage(storage, undefined, options);
	}

	static inMemory(data: AuthStorageData = {}, options?: AuthStorageOptions): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage, options);
	}

	private keychain(): KeychainBackend | undefined {
		return this.options.keychain ?? detectKeychain(process.platform);
	}

	/**
	 * Removes the keychain entry behind `previous` (an API key's reference or an OAuth stub's) when it is our own
	 * keychain reference and `next` no longer uses it. Failures are ignored unless `strict`: the credential change
	 * already succeeded and a leftover entry is harmless.
	 */
	private async releaseKeychainEntry(
		provider: string,
		previous: Credential | undefined,
		next?: Credential,
		strict = false,
	): Promise<void> {
		const entry = keychainEntry(provider, previous);
		if (!entry || keychainEntry(provider, next)?.reference === entry.reference) return;
		const keychain = this.keychain();
		if (!keychain?.isOwnReference(entry.reference, entry.account)) return;
		try {
			await keychain.remove(entry.account);
		} catch (error) {
			// Leave the entry; logout must not fail because the keychain is locked or gone.
			if (strict) throw error;
		}
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		const parsed: unknown = JSON.parse(stripBom(content));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error("Invalid auth.json: expected an object");
		}
		for (const [provider, credential] of Object.entries(parsed)) {
			const reason = invalidEntryReason(credential);
			if (reason) throw new Error(`Invalid auth.json credential for provider "${provider}": ${reason}`);
		}
		return parsed as AuthStorageData;
	}

	private updateReadState(data: AuthStorageData, revision?: string): void {
		this.readState.data = data;
		this.readState.revision = revision;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		let revision: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: undefined };
			});
			this.updateReadState(this.parseStorageData(content), revision);
		} catch {
			// Preserve the last valid in-memory snapshot.
		}
	}

	private async reloadFromStorageAsync(options?: AuthOperationOptions): Promise<AuthStorageData> {
		return this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			const revision = this.authPath ? getFileRevision(this.authPath) : undefined;
			this.updateReadState(currentData, revision);
			return { result: currentData };
		}, options);
	}

	private async readLatestData(options?: AuthOperationOptions): Promise<AuthStorageData> {
		options?.signal?.throwIfAborted();
		if (!this.authPath) {
			const reload = this.reloadFromStorageAsync(options);
			return options?.signal ? reload : reload.catch(() => this.readState.data);
		}
		const revision = getFileRevision(this.authPath);
		if (revision !== undefined && revision === this.readState.revision) return this.readState.data;
		if (!this.readState.reload) {
			const controller = new AbortController();
			const reload: AuthFileReload = {
				controller,
				promise: this.reloadFromStorageAsync({ signal: controller.signal }),
				readers: 0,
			};
			this.readState.reload = reload;
			void reload.promise.then(
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
				() => {
					if (this.readState.reload === reload) this.readState.reload = undefined;
				},
			);
		}

		const reload = this.readState.reload;
		reload.readers++;
		try {
			const result = raceWithAbortSignal(reload.promise, options?.signal);
			return options?.signal ? await result : await result.catch(() => this.readState.data);
		} finally {
			reload.readers--;
			if (reload.readers === 0 && this.readState.reload === reload) {
				this.readState.reload = undefined;
				reload.controller.abort();
			}
		}
	}

	/**
	 * Where `auth.json` keeps this provider's secret: `keychain` when the entry is this keychain's own reference (an API
	 * key's or an OAuth stub's), else `auth.json`. Reads the last loaded file, never the keychain; no entry: undefined.
	 */
	storedIn(provider: string): "keychain" | "auth.json" | undefined {
		const credential = ownCredential(this.readState.data, provider);
		if (!credential) return undefined;
		const entry = keychainEntry(provider, credential);
		return entry && this.keychain()?.isOwnReference(entry.reference, entry.account) ? "keychain" : "auth.json";
	}

	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const credential = ownCredential(await this.readLatestData(options), provider);
		options?.signal?.throwIfAborted();
		// A keychain `!command` runs in the background: the screen keeps drawing while it does.
		if (credential?.type !== "api_key")
			return raceWithAbortSignal(resolveKeychainOAuthAsync(credential), options?.signal);
		// A key saved with a custom host is one keychain record: the stub stands for key, host and region together.
		const full = await raceWithAbortSignal(resolveKeychainEndpointAsync(credential), options?.signal);
		if (full?.type !== "api_key" || full.key === undefined) return full;
		return {
			...full,
			key: await raceWithAbortSignal(resolveConfigValueAsync(full.key, full.env), options?.signal),
		};
	}

	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.modifyGuarded(provider, fn, options);
	}

	/**
	 * `modify`, plus `onFailure`: when `fn`, the file write or a lock check fails, it runs with what the file holds for
	 * `provider` before the lock is released, so undoing an outside write cannot interleave with another writer.
	 */
	async modifyGuarded(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
		onFailure?: (held: HeldCredential) => Promise<void>,
	): Promise<Credential | undefined> {
		let latestData = this.readState.data;
		let revision: string | undefined;
		// As stored: an OAuth stub stays a stub here, and `fn` sees the credential it stands for.
		let previous: Credential | undefined;
		let stored: Credential | undefined;
		const held = (state: LockFailureState): HeldCredential => {
			if (state === "unreadable") return state;
			try {
				return { credential: ownCredential(this.parseStorageData(state.content), provider) };
			} catch {
				return "unreadable";
			}
		};
		const result = await this.storage.withLockAsync(
			async (content) => {
				const currentData = this.parseStorageData(content);
				previous = ownCredential(currentData, provider);
				stored = previous;
				const current = resolveKeychainOAuth(previous, true);
				const next = await fn(current);
				if (next === undefined) {
					latestData = currentData;
					revision = this.authPath ? getFileRevision(this.authPath) : undefined;
					return { result: current };
				}

				stored = await keepInKeychain(this.keychain(), provider, previous, next);
				const merged: AuthStorageData = { ...currentData, [provider]: stored };
				latestData = merged;
				return { result: next, next: JSON.stringify(merged, null, 2) };
			},
			options,
			onFailure && ((state) => onFailure(held(state))),
		);
		this.updateReadState(latestData, revision);
		if (stored !== previous) await this.releaseKeychainEntry(provider, previous, stored);
		return result;
	}

	/** Removes the entry under the lock and returns what it held. */
	private async removeEntry(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		let latestData = this.readState.data;
		let previous: Credential | undefined;
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			previous = ownCredential(currentData, provider);
			delete currentData[provider];
			latestData = currentData;
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		}, options);
		this.updateReadState(latestData);
		return previous;
	}

	async delete(provider: string, options?: AuthOperationOptions): Promise<void> {
		await this.releaseKeychainEntry(provider, await this.removeEntry(provider, options));
	}

	/**
	 * `delete` that reports a keychain entry it could not remove, so a caller never says "cleared" while the secret
	 * stays. The `auth.json` entry is put back first, so the credential still works and the clear can be retried;
	 * `KeychainReleaseError.restored` says whether that worked.
	 */
	async deleteOrKeep(provider: string, options?: AuthOperationOptions): Promise<void> {
		const previous = await this.removeEntry(provider, options);
		try {
			await this.releaseKeychainEntry(provider, previous, undefined, true);
		} catch {
			throw new KeychainReleaseError(await this.restoreEntry(provider, previous));
		}
	}

	private async restoreEntry(provider: string, previous: Credential | undefined): Promise<boolean> {
		if (!previous) return false;
		try {
			let latestData = this.readState.data;
			await this.storage.withLockAsync(async (content) => {
				const currentData = this.parseStorageData(content);
				if (Object.hasOwn(currentData, provider)) return { result: undefined };
				latestData = { ...currentData, [provider]: previous };
				return { result: undefined, next: JSON.stringify(latestData, null, 2) };
			});
			this.updateReadState(latestData);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Calls `onChange` when the file changes after this call, e.g. another Octocode process saved or removed a
	 * credential. A file-system watcher on its folder sees it (`intervalMs` paces the stat polling only where that
	 * watcher fails); it never keeps the process alive. Returns the stop function.
	 * Only revisions are compared: no credential is read or logged.
	 */
	watch(onChange: () => void, intervalMs = 1000): () => void {
		const path = this.authPath;
		if (!path) return () => {};
		let seen = getFileRevision(path);
		return watchFileChanges(
			path,
			() => {
				const revision = getFileRevision(path);
				if (revision === seen) return;
				seen = revision;
				onChange();
			},
			{ intervalMs },
		);
	}

	/** List credential metadata without resolving configured key values. */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = Object.entries(await this.readLatestData(options));
		options?.signal?.throwIfAborted();
		return entries
			.filter(([, credential]) => isActiveCredential(credential))
			.map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}
}
