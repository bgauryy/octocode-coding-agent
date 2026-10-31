/**
 * CredentialStore implementation backed by auth.json.
 * Provider auth orchestration belongs to ModelRuntime and octocode-ai Models.
 */

import { isActiveCredential, type AuthOperationOptions, type Credential, type CredentialInfo, type CredentialStore } from "@octocodeai/octocode-ai";
import { join } from "path";
import { getAgentDir } from "../config.ts";
import { raceWithAbortSignal } from "@octocodeai/octocode-ai/utils/abort";
import { getFileRevision, normalizePath } from "../../../common/src/paths.ts";
import { stripBom } from "../../../common/src/text.ts";
import { type AuthStorageBackend, type AuthStorageData, FileAuthStorageBackend, InMemoryAuthStorageBackend } from "./auth-storage/backends.ts";
import { detectKeychain, type KeychainBackend } from "./auth-storage/keychain.ts";
import { resolveConfigValue } from "@octocodeai/octocode-ai/utils/resolve-config-value";
import { readJsonFile } from "../../../common/src/json.ts";

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

	/**
	 * Removes the keychain entry behind `previous` when its key is our own keychain reference and `next` no longer
	 * uses it. Failures are ignored: the credential change already succeeded and a leftover entry is harmless.
	 */
	private async releaseKeychainEntry(
		provider: string,
		previous: Credential | undefined,
		next?: Credential,
	): Promise<void> {
		if (previous?.type !== "api_key" || !previous.key?.startsWith("!")) return;
		if (next?.type === "api_key" && next.key === previous.key) return;
		const keychain = this.options.keychain ?? detectKeychain(process.platform);
		if (!keychain?.isOwnReference(previous.key, provider)) return;
		try {
			await keychain.remove(provider);
		} catch {
			// Leave the entry; logout must not fail because the keychain is locked or gone.
		}
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(stripBom(content)) as AuthStorageData;
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

	async read(provider: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		const credential = (await this.readLatestData(options))[provider];
		options?.signal?.throwIfAborted();
		if (credential?.type !== "api_key") return credential;
		if (credential.key === undefined) return credential;
		return { ...credential, key: resolveConfigValue(credential.key, credential.env) };
	}

	async modify(
		provider: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		let latestData = this.readState.data;
		let revision: string | undefined;
		let previous: Credential | undefined;
		const result = await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			previous = currentData[provider];
			const next = await fn(currentData[provider]);
			if (next === undefined) {
				latestData = currentData;
				revision = this.authPath ? getFileRevision(this.authPath) : undefined;
				return { result: currentData[provider] };
			}

			const merged: AuthStorageData = { ...currentData, [provider]: next };
			latestData = merged;
			return { result: next, next: JSON.stringify(merged, null, 2) };
		}, options);
		this.updateReadState(latestData, revision);
		if (result !== previous) await this.releaseKeychainEntry(provider, previous, result);
		return result;
	}

	async delete(provider: string, options?: AuthOperationOptions): Promise<void> {
		let latestData = this.readState.data;
		let previous: Credential | undefined;
		await this.storage.withLockAsync(async (content) => {
			const currentData = this.parseStorageData(content);
			previous = currentData[provider];
			delete currentData[provider];
			latestData = currentData;
			return { result: undefined, next: JSON.stringify(currentData, null, 2) };
		}, options);
		this.updateReadState(latestData);
		await this.releaseKeychainEntry(provider, previous);
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

/**
 * One-off synchronous read of a stored credential from an auth.json file,
 * without instantiating a store or resolving configured key values.
 */
export function readStoredCredential(
	providerId: string,
	authPath: string = join(getAgentDir(), "auth.json"),
): Credential | undefined {
	try {
		const data = readJsonFile(normalizePath(authPath)) as AuthStorageData;
		return data[providerId];
	} catch {
		return undefined;
	}
}
