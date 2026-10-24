import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@octocodeai/octocode-ai";

/** Rewrites a credential just before it is saved. */
export type CredentialWriteTransform = (credential: Credential) => Promise<Credential>;

/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements CredentialStore {
	private readonly store: CredentialStore;
	private readonly overrides = new Map<string, string>();
	private readonly writeTransforms = new Map<string, CredentialWriteTransform>();

	constructor(store: CredentialStore) {
		this.store = store;
	}

	setRuntimeApiKey(providerId: string, apiKey: string): void {
		this.overrides.set(providerId, apiKey);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const override = this.overrides.get(providerId);
		return override ? { type: "api_key", key: override } : this.store.read(providerId, options);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list(options)).map((entry) => [entry.providerId, entry]));
		options?.signal?.throwIfAborted();
		for (const providerId of this.overrides.keys()) {
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	/** Runs `run` while credentials saved for `providerId` pass through `transform`, e.g. to move a key into a keychain. */
	async withWriteTransform<T>(
		providerId: string,
		transform: CredentialWriteTransform,
		run: () => Promise<T>,
	): Promise<T> {
		this.writeTransforms.set(providerId, transform);
		try {
			return await run();
		} finally {
			if (this.writeTransforms.get(providerId) === transform) this.writeTransforms.delete(providerId);
		}
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const transform = this.writeTransforms.get(providerId);
		if (!transform) return this.store.modify(providerId, fn, options);
		return this.modifyWithTransform(providerId, fn, transform, options);
	}

	/** Once an external secret write starts, finish saving its reference even if the caller cancels. */
	private async modifyWithTransform(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		transform: CredentialWriteTransform,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const controller = new AbortController();
		const onAbort = () => controller.abort(options?.signal?.reason);
		const detach = () => options?.signal?.removeEventListener("abort", onAbort);
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		if (options?.signal?.aborted) onAbort();
		try {
			return await this.store.modify(
				providerId,
				async (current) => {
					const next = await fn(current);
					controller.signal.throwIfAborted();
					if (next === undefined) return undefined;
					detach();
					return transform(next);
				},
				{ ...options, signal: controller.signal },
			);
		} finally {
			detach();
		}
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.store.delete(providerId, options);
		this.overrides.delete(providerId);
	}
}
