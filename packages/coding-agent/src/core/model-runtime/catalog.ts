import type {
	AnyModel,
	Api,
	AuthOperationOptions,
	AuthCheck,
	Model,
	ModelType,
	ModelTypeMap,
	MutableModels,
	Provider,
	StreamOptions,
} from "@octocodeai/octocode-ai";
import type { CachePreferenceLayer } from "@octocodeai/octocode-ai/utils/cache-policy";
import { dirname } from "node:path";
import { resolveConfiguredCache } from "../cache-configuration.ts";
import {
	type CompatibilityRequestConfig,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
} from "../provider-composer.ts";
import type { ModelAvailability } from "./availability.ts";
import type { ProviderLayers } from "./provider-layers.ts";

/** The read-only catalog and availability queries of a model runtime, over the collections it owns. */
export abstract class ModelCatalog {
	protected abstract readonly models: MutableModels;
	protected abstract readonly layers: ProviderLayers;
	protected abstract readonly modelsPath: string | undefined;
	protected abstract readonly availability: ModelAvailability;

	getProviders(): readonly Provider[] {
		return this.models.getProviders();
	}
	getConfigurationDirectory(): string | undefined {
		return this.modelsPath ? dirname(this.modelsPath) : undefined;
	}
	getProvider(providerId: string): Provider | undefined {
		return this.models.getProvider(providerId);
	}
	getModels(providerId?: string): readonly Model<Api>[] {
		return this.models.getModels(providerId);
	}

	getCachePolicy(model: Model<Api>, options?: StreamOptions, settings?: readonly CachePreferenceLayer[]) {
		return resolveConfiguredCache(model, this.layers.config.getProvider(model.provider), options, settings);
	}

	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.models.getModel(providerId, modelId);
	}

	getModelsOfType<TType extends ModelType>(type: TType, providerId?: string): readonly ModelTypeMap[TType][] {
		return this.models.getModelsOfType(type, providerId);
	}

	getModelOfType<TType extends ModelType>(
		type: TType,
		providerId: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.models.getModelOfType(type, providerId, modelId);
	}

	getAllModels(providerId?: string): readonly AnyModel[] {
		return this.models.getAllModels(providerId);
	}

	getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return this.models.getAvailableOfType(type, providerId, options);
	}

	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		return this.models.getAllAvailable(providerId, options);
	}

	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId, options);
	}

	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		return this.availability.getAvailable(providerId, options);
	}

	setDisabledProviders(providerIds: readonly string[]): void {
		this.availability.setDisabledProviders(providerIds);
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.availability.snapshot.available;
	}

	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.layers.extensionProviders.get(providerId);
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...new Set([...this.layers.extensionProviders.keys(), ...this.layers.nativeExtensionProviders.keys()])];
	}

	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.layers.nativeExtensionProviders.get(providerId);
	}

	/** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.layers.config.getProvider(model.provider),
			this.layers.extensionProviders.get(model.provider),
		);
	}

	isUsingOAuth(providerId: string): boolean {
		return this.availability.snapshot.auth.get(providerId)?.type === "oauth";
	}

	isUsingSubscription(providerId: string): boolean {
		return this.isUsingOAuth(providerId) && this.models.getProvider(providerId)?.auth.oauth?.isSubscription === true;
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.availability.snapshot.configuredProviders.has(providerId);
	}
}
