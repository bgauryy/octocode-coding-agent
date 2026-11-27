import type { Provider } from "@octocodeai/octocode-ai";
import { configuredRequestAuthStatus, type ProviderConfigInput } from "../provider-composer.ts";
import type { VirtualModelDefinition } from "../virtual-models.ts";
import type { ModelAvailability } from "./availability.ts";
import type { ProviderLayers } from "./provider-layers.ts";

/**
 * Provider and virtual-model registration at runtime. Each change recomposes the provider, updates the model
 * snapshot, and starts a background refresh through `refresh`.
 */
export class ProviderRegistrations {
	private readonly layers: ProviderLayers;
	private readonly availability: ModelAvailability;
	private readonly refresh: () => void;

	constructor(layers: ProviderLayers, availability: ModelAvailability, refresh: () => void) {
		this.layers = layers;
		this.availability = availability;
		this.refresh = refresh;
	}

	registerNativeProvider(provider: Provider): void {
		if (!provider.id.trim()) throw new Error("Provider id must not be empty.");
		this.layers.featureProviders.delete(provider.id);
		this.layers.nativeFeatureProviders.set(provider.id, provider);
		this.layers.recomposeProvider(provider.id);
		this.availability.updateModelSnapshot();
		this.availability.markProvisionallyConfigured(
			provider.id,
			configuredRequestAuthStatus(this.layers.config.getProvider(provider.id), undefined),
			provider.auth.oauth && !provider.auth.apiKey ? "oauth" : "api_key",
		);
		this.refresh();
	}

	registerProvider(providerId: string, config: ProviderConfigInput): void {
		const effective = this.layers.setFeatureProvider(providerId, config);
		this.layers.recomposeProvider(providerId);
		this.availability.updateModelSnapshot();
		this.availability.markProvisionallyConfigured(
			providerId,
			configuredRequestAuthStatus(this.layers.config.getProvider(providerId), effective),
			effective.oauth && !effective.apiKey ? "oauth" : "api_key",
		);
		this.refresh();
	}

	unregisterProvider(providerId: string): void {
		this.layers.featureProviders.delete(providerId);
		this.layers.nativeFeatureProviders.delete(providerId);
		this.layers.recomposeProvider(providerId);
		this.availability.updateModelSnapshot();
		this.refresh();
	}

	registerVirtualModel(definition: VirtualModelDefinition): void {
		const providerId = definition.provider;
		this.layers.addVirtualModel(definition);
		if (!this.layers.recomposeProvider(providerId)) this.availability.markVirtualProviderConfigured(providerId);
		this.availability.updateModelSnapshot();
		this.refresh();
	}

	unregisterVirtualModel(providerId: string, id: string): void {
		if (!this.layers.removeVirtualModel(providerId, id)) return;
		this.layers.recomposeProvider(providerId);
		this.availability.updateModelSnapshot();
		this.refresh();
	}
}
