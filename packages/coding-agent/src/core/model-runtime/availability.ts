import type { Api, AuthCheck, AuthOperationOptions, AuthType, Model, MutableModels } from "@octocodeai/octocode-ai";
import { operationSignal } from "@octocodeai/octocode-ai/utils/abort";
import { type AuthStatus, configuredRequestAuthStatus } from "../provider-composer.ts";
import type { RuntimeCredentials } from "../runtime-credentials.ts";
import type { ProviderLayers } from "./provider-layers.ts";
import type { ModelRuntimeSnapshot } from "./types.ts";
import { errorMessage } from "../../utils/guards.ts";

/**
 * The model runtime's availability snapshot: which models are usable, which providers have auth, and the latest
 * availability error. Full and per-provider refresh passes are sequenced so a stale pass never overwrites a newer one.
 */
export class ModelAvailability {
	private readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	snapshot: ModelRuntimeSnapshot = {
		all: [],
		available: [],
		configuredProviders: new Set(),
		storedProviders: new Set(),
		auth: new Map(),
	};
	private availabilityRefreshSeq = 0;
	private availabilityErrorSeq = 0;
	private readonly providerAvailabilitySeq = new Map<string, number>();
	availabilityError: string | undefined;

	constructor(models: MutableModels, credentials: RuntimeCredentials) {
		this.models = models;
		this.credentials = credentials;
	}

	updateModelSnapshot(): void {
		const all = [...this.models.getModels()];
		this.snapshot = {
			...this.snapshot,
			all,
			available: all.filter((model) => this.snapshot.configuredProviders.has(model.provider)),
		};
	}

	private async runAvailabilityRefresh(seq: number, errorSeq: number, signal: AbortSignal): Promise<void> {
		const providers = this.models.getProviders();
		const [available, checks, credentials] = await Promise.all([
			this.models.getAvailable(undefined, { signal }),
			Promise.all(
				providers.map(async (provider): Promise<[string, AuthCheck | undefined]> => [
					provider.id,
					await this.models.checkAuth(provider.id, { signal }),
				]),
			),
			this.credentials.list({ signal }),
		]);
		if (seq !== this.availabilityRefreshSeq) return;
		const auth = new Map(checks);
		const configuredProviders = new Set(
			checks.filter((entry): entry is [string, AuthCheck] => entry[1] !== undefined).map(([providerId]) => providerId),
		);
		this.snapshot = {
			all: [...this.models.getModels()],
			available: [...available],
			configuredProviders,
			storedProviders: new Set(credentials.map((entry) => entry.providerId)),
			auth,
		};
		if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
	}

	queueAvailabilityRefresh(signal?: AbortSignal): Promise<void> {
		const seq = ++this.availabilityRefreshSeq;
		for (const [providerId, providerSeq] of this.providerAvailabilitySeq) {
			this.providerAvailabilitySeq.set(providerId, providerSeq + 1);
		}
		const errorSeq = ++this.availabilityErrorSeq;
		const effectiveSignal = operationSignal(signal);
		return this.runAvailabilityRefresh(seq, errorSeq, effectiveSignal).catch((error) => {
			if (errorSeq === this.availabilityErrorSeq && !effectiveSignal.aborted) {
				this.availabilityError = errorMessage(error);
			}
			throw error;
		});
	}

	async refreshProviderAvailability(providerId: string, signal: AbortSignal): Promise<void> {
		// Invalidate any full availability pass that started before this credential change.
		++this.availabilityRefreshSeq;
		const providerSeq = (this.providerAvailabilitySeq.get(providerId) ?? 0) + 1;
		this.providerAvailabilitySeq.set(providerId, providerSeq);
		const errorSeq = ++this.availabilityErrorSeq;
		try {
			const [available, auth, credential] = await Promise.all([
				this.models.getAvailable(providerId, { signal }),
				this.models.checkAuth(providerId, { signal }),
				this.credentials.read(providerId, { signal }),
			]);
			signal.throwIfAborted();
			if (this.providerAvailabilitySeq.get(providerId) !== providerSeq) return;
			const configuredProviders = new Set(this.snapshot.configuredProviders);
			const storedProviders = new Set(this.snapshot.storedProviders);
			const authByProvider = new Map(this.snapshot.auth);
			if (auth) {
				configuredProviders.add(providerId);
				authByProvider.set(providerId, auth);
			} else {
				configuredProviders.delete(providerId);
				authByProvider.delete(providerId);
			}
			if (credential) storedProviders.add(providerId);
			else storedProviders.delete(providerId);
			const all = [...this.models.getModels()];
			const availableById = new Map(
				[...this.snapshot.available.filter((model) => model.provider !== providerId), ...available].map((model) => [
					`${model.provider}\0${model.id}`,
					model,
				]),
			);
			this.snapshot = {
				all,
				available: all.flatMap((model) => availableById.get(`${model.provider}\0${model.id}`) ?? []),
				configuredProviders,
				storedProviders,
				auth: authByProvider,
			};
			if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
		} catch (error) {
			if (
				this.providerAvailabilitySeq.get(providerId) === providerSeq &&
				errorSeq === this.availabilityErrorSeq &&
				!signal.aborted
			) {
				this.availabilityError = errorMessage(error);
			}
			throw error;
		}
	}

	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		if (providerId) {
			const errorSeq = ++this.availabilityErrorSeq;
			try {
				const available = await this.models.getAvailable(providerId, options);
				if (errorSeq === this.availabilityErrorSeq) this.availabilityError = undefined;
				return available;
			} catch (error) {
				if (errorSeq === this.availabilityErrorSeq && !options?.signal?.aborted) {
					this.availabilityError = errorMessage(error);
				}
				throw error;
			}
		}
		await this.queueAvailabilityRefresh(options?.signal);
		return this.snapshot.available;
	}

	/**
	 * Mark a newly registered provider as configured when it has a stored credential or a configured
	 * API key. Availability checks run asynchronously, and callers such as initial model selection
	 * read the snapshot before they finish. The next availability pass replaces this entry.
	 */
	markProvisionallyConfigured(providerId: string, configuredStatus: AuthStatus | undefined, type: AuthType): void {
		if (!this.snapshot.storedProviders.has(providerId) && !configuredStatus?.configured) return;
		const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
		const auth = new Map(this.snapshot.auth);
		// Never clobber a real check result.
		if (!auth.get(providerId)) auth.set(providerId, { type, source: "configured provider" });
		this.snapshot = {
			...this.snapshot,
			auth,
			configuredProviders,
			available: this.snapshot.all.filter((model) => configuredProviders.has(model.provider)),
		};
	}

	/**
	 * A provider of only virtual models needs no credentials. Mark it configured now: session
	 * restore checks auth before the next availability refresh lands.
	 */
	markVirtualProviderConfigured(providerId: string): void {
		if (this.snapshot.configuredProviders.has(providerId)) return;
		const auth = new Map(this.snapshot.auth).set(providerId, { type: "api_key", source: "virtual" });
		const configuredProviders = new Set(this.snapshot.configuredProviders).add(providerId);
		this.snapshot = { ...this.snapshot, auth, configuredProviders };
	}

	/** How a provider is configured: runtime key, stored credential, configured key, then the latest auth check. */
	getProviderAuthStatus(providerId: string, credentials: RuntimeCredentials, layers: ProviderLayers): AuthStatus {
		if (credentials.hasRuntimeApiKey(providerId)) return { configured: true, source: "runtime" };
		if (this.snapshot.storedProviders.has(providerId)) return { configured: true, source: "stored" };
		const configured = configuredRequestAuthStatus(
			layers.config.getProvider(providerId),
			layers.extensionProviders.get(providerId),
		);
		if (configured) return configured;
		const check = this.snapshot.auth.get(providerId);
		return check ? { configured: true, source: "environment", label: check.source } : { configured: false };
	}
}
