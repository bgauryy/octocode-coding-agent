import type {
	AuthInteraction,
	AuthOperationOptions,
	AuthType,
	Credential,
	LoginOptions,
	MutableModels,
} from "@octocodeai/octocode-ai";
import { operationSignal, raceWithAbortSignal } from "@octocodeai/octocode-ai/utils/abort";
import type { RuntimeCredentials } from "../runtime-credentials.ts";
import type { ModelAvailability } from "./availability.ts";
import type { ProviderLayers } from "./provider-layers.ts";
import { CredentialSynchronizationError, type CredentialSynchronizationOperation } from "./types.ts";

/** The runtime parts a credential change updates. */
export interface CredentialOperationsHost {
	readonly models: MutableModels;
	readonly credentials: RuntimeCredentials;
	readonly layers: ProviderLayers;
	readonly availability: ModelAvailability;
}

/**
 * Credential changes (login, logout, runtime API keys), serialized per provider. Each change is followed by
 * recomposing the provider and refreshing its models and availability.
 */
export class CredentialOperations {
	private readonly host: CredentialOperationsHost;
	private readonly credentialOperations = new Map<string, Promise<unknown>>();

	constructor(host: CredentialOperationsHost) {
		this.host = host;
	}

	private enqueueCredentialOperation<T>(providerId: string, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
		const previous = this.credentialOperations.get(providerId) ?? Promise.resolve();
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const operation = (async () => {
			await previous.catch(() => {});
			signal.throwIfAborted();
			markStarted?.();
			return task();
		})();
		const tail = operation.catch(() => {});
		this.credentialOperations.set(providerId, tail);
		void tail.then(() => {
			if (this.credentialOperations.get(providerId) === tail) this.credentialOperations.delete(providerId);
		});
		return raceWithAbortSignal(started, signal).then(() => operation);
	}

	private async synchronizeCredentialState(
		providerId: string,
		operation: CredentialSynchronizationOperation,
		credential: Credential | undefined,
		signal: AbortSignal,
	): Promise<void> {
		const { models, layers, availability } = this.host;
		try {
			signal.throwIfAborted();
			layers.recomposeProvider(providerId);
			const compositionError = layers.compositionErrors.get(providerId);
			if (compositionError) throw new Error(compositionError);
			const result = await models.refresh({ allowNetwork: false, providers: [providerId], signal });
			if (result.aborted) signal.throwIfAborted();
			const refreshError = result.errors.get(providerId);
			if (refreshError) throw refreshError;
			availability.updateModelSnapshot();
			await availability.refreshProviderAvailability(providerId, signal);
		} catch (cause) {
			throw new CredentialSynchronizationError(providerId, operation, credential, { cause });
		}
	}

	setRuntimeApiKey(providerId: string, apiKey: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.host.credentials.setRuntimeApiKey(providerId, apiKey);
			await this.synchronizeCredentialState(providerId, "setRuntimeApiKey", { type: "api_key", key: apiKey }, signal);
		});
	}

	removeRuntimeApiKey(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			this.host.credentials.removeRuntimeApiKey(providerId);
			await this.synchronizeCredentialState(providerId, "removeRuntimeApiKey", undefined, signal);
		});
	}

	login(providerId: string, type: AuthType, interaction: AuthInteraction, options?: LoginOptions): Promise<Credential> {
		const signal = operationSignal(interaction.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			const credential = await this.host.models.login(providerId, type, { ...interaction, signal }, options);
			await this.synchronizeCredentialState(providerId, "login", credential, signal);
			return credential;
		});
	}

	logout(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		const signal = operationSignal(options.signal);
		return this.enqueueCredentialOperation(providerId, signal, async () => {
			await this.host.models.logout(providerId, { signal });
			await this.synchronizeCredentialState(providerId, "logout", undefined, signal);
		});
	}
}
