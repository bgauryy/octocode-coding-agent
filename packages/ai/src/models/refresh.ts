import { ModelsError, readCredential } from "../auth/resolve.ts";
import type { AuthContext, Credential, CredentialStore } from "../auth/types.ts";
import type { ModelsStore } from "../models-store.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { resolveRefreshCredential } from "./auth.ts";
import type { ModelsPublication, ModelsRefreshOptions, ModelsRefreshResult, Provider } from "./contracts.ts";
import { withKnownModelTypes } from "./create-provider.ts";

/** What the provider refresh coordinator reads from the `Models` collection that owns it. */
interface ModelsRefreshHost {
	getProviders(): readonly Provider[];
	readonly credentials: CredentialStore;
	readonly modelsStore: ModelsStore;
	readonly authContext: AuthContext;
}

/**
 * Coordinates dynamic provider model refreshes: one generation and abort controller per
 * provider, so replacing a provider or starting a newer refresh supersedes the older one,
 * and serialized, generation-checked publication of each provider's catalog.
 */
export class ProviderModelsRefresher {
	private refreshGenerations = new Map<string, number>();
	private refreshControllers = new Map<string, AbortController>();
	private publicationChains = new Map<string, Promise<unknown>>();

	private readonly host: ModelsRefreshHost;

	constructor(host: ModelsRefreshHost) {
		this.host = host;
	}

	/** Supersedes the refresh of each given provider and of every provider still refreshing. */
	supersedeAll(providerIds: Iterable<string>): void {
		for (const id of new Set([...providerIds, ...this.refreshControllers.keys()])) {
			this.supersede(id);
		}
	}

	supersede(providerId: string): number {
		const generation = (this.refreshGenerations.get(providerId) ?? 0) + 1;
		this.refreshGenerations.set(providerId, generation);
		const previous = this.refreshControllers.get(providerId);
		if (previous) {
			this.refreshControllers.delete(providerId);
			previous.abort();
		}
		return generation;
	}

	private beginProviderRefresh(providerId: string): { generation: number; controller: AbortController } {
		const generation = this.supersede(providerId);
		const controller = new AbortController();
		this.refreshControllers.set(providerId, controller);
		return { generation, controller };
	}

	private publishProviderModels(
		providerId: string,
		generation: number,
		signal: AbortSignal,
		publication: ModelsPublication,
	): Promise<boolean> {
		const previous = this.publicationChains.get(providerId) ?? Promise.resolve();
		const queued = (async () => {
			await previous.catch(() => {});
			if (signal.aborted || this.refreshGenerations.get(providerId) !== generation) return false;

			if (publication.persist === null) {
				await this.host.modelsStore.delete(providerId, { signal });
			} else if (publication.persist !== undefined) {
				await this.host.modelsStore.write(providerId, structuredClone(publication.persist), { signal });
			}

			if (signal.aborted || this.refreshGenerations.get(providerId) !== generation) return false;
			publication.update?.();
			return true;
		})();
		const tail = queued.catch(() => {});
		this.publicationChains.set(providerId, tail);
		void tail.then(() => {
			if (this.publicationChains.get(providerId) === tail) this.publicationChains.delete(providerId);
		});
		return raceWithAbortSignal(queued, signal);
	}

	private async runProviderRefreshPhase(
		provider: Provider & Required<Pick<Provider, "refreshModels">>,
		credential: Credential | undefined,
		allowNetwork: boolean,
		force: boolean | undefined,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		const stored = await this.host.modelsStore.read(provider.id, { signal });
		await provider.refreshModels({
			credential,
			stored: stored ? withKnownModelTypes(structuredClone(stored)) : undefined,
			publish: (publication) => this.publishProviderModels(provider.id, generation, signal, publication),
			allowNetwork,
			force: allowNetwork ? force : undefined,
			signal,
			baseUrl: provider.baseUrl,
		});
	}

	async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const allowNetwork = options.allowNetwork ?? true;
		const callerSignal = operationSignal(options.signal);
		const errors = new Map<string, Error>();
		if (callerSignal.aborted) return { aborted: true, errors };
		const selected = options.providers ? new Set(options.providers) : undefined;
		const refreshable = this.host
			.getProviders()
			.filter(
				(provider): provider is Provider & Required<Pick<Provider, "refreshModels">> =>
					provider.refreshModels !== undefined && (!selected || selected.has(provider.id)),
			);

		const refresh = Promise.all(
			refreshable.map(async (provider) => {
				const { generation, controller } = this.beginProviderRefresh(provider.id);
				const signal = AbortSignal.any([callerSignal, controller.signal]);
				const operation = (async () => {
					let storedCredential: Credential | undefined;
					let credentialFailure: { error: unknown } | undefined;
					try {
						storedCredential = await readCredential(this.host.credentials, provider.id, signal);
					} catch (error) {
						credentialFailure = { error };
					}

					// Restore cached provider state before auth resolution or network access.
					await this.runProviderRefreshPhase(provider, storedCredential, false, undefined, generation, signal);
					if (credentialFailure) throw credentialFailure.error;
					if (!allowNetwork || signal.aborted) return;

					const credential = await resolveRefreshCredential(
						this.host.credentials,
						this.host.authContext,
						provider,
						storedCredential,
						signal,
					);
					if (!credential) return;
					await this.runProviderRefreshPhase(provider, credential, true, options.force, generation, signal);
				})();

				try {
					await raceWithAbortSignal(operation, signal);
				} catch (error) {
					if (!signal.aborted) {
						errors.set(
							provider.id,
							error instanceof Error
								? error
								: new ModelsError("model_source", `Model refresh failed for ${provider.id}`, { cause: error }),
						);
					}
				} finally {
					if (this.refreshControllers.get(provider.id) === controller) {
						this.refreshControllers.delete(provider.id);
					}
				}
			}),
		);

		try {
			await raceWithAbortSignal(refresh, callerSignal);
		} catch (error) {
			if (!callerSignal.aborted) throw error;
		}

		return { aborted: callerSignal.aborted, errors: new Map(errors) };
	}
}
