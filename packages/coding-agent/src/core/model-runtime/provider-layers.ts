import type { MutableModels, Provider } from "@octocodeai/octocode-ai";
import type { ModelConfig } from "../model-config.ts";
import { composeModelProvider, type ProviderConfigInput, validateExtensionProvider } from "../provider-composer.ts";
import { type KnownModelLookup, knownModelLookup } from "../provider-composer/known-models.ts";
import {
	createVirtualModel,
	isVirtualModel,
	type VirtualModelDefinition,
	withVirtualModels,
} from "../virtual-models.ts";
import type { RegisteredVirtualModel } from "./types.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

/**
 * The provider layers the model runtime composes into its Models collection: built-in providers, native extension
 * providers, models.json, extension registrations and virtual models.
 */
export class ProviderLayers {
	private readonly models: MutableModels;
	readonly builtins = new Map<string, Provider>();
	readonly nativeExtensionProviders = new Map<string, Provider>();
	readonly extensionProviders = new Map<string, ProviderConfigInput>();
	/** Virtual models by provider id, then model id. */
	readonly virtualModels = new Map<string, Map<string, RegisteredVirtualModel>>();
	readonly compositionErrors = new Map<string, string>();
	/** Built-in models a `models.json` entry can take its metadata from (see `known-models.ts`). */
	private readonly known: KnownModelLookup = knownModelLookup(this.builtins);
	config: ModelConfig;

	constructor(models: MutableModels, config: ModelConfig, providers: readonly Provider[]) {
		this.models = models;
		this.config = config;
		for (const provider of providers) this.builtins.set(provider.id, provider);
	}

	private providerIds(): Set<string> {
		return new Set([
			...this.builtins.keys(),
			...this.nativeExtensionProviders.keys(),
			...this.config.getProviderIds(),
			...this.extensionProviders.keys(),
			...this.virtualModels.keys(),
		]);
	}

	/** An explicit context definition stays in control when a provider reports a different runtime capacity. */
	hasContextWindowOverride(providerId: string, modelId: string): boolean {
		const config = this.config.getProvider(providerId);
		return (
			config?.models?.some((model) => model.id === modelId && model.contextWindow !== undefined) === true ||
			config?.modelOverrides?.[modelId]?.contextWindow !== undefined ||
			this.extensionProviders
				.get(providerId)
				?.models?.some((model) => model.id === modelId && "contextWindow" in model) === true
		);
	}

	/** Returns the provider without virtual models, or undefined when only virtual models define it. */
	recomposeProvider(providerId: string): Provider | undefined {
		const provider = this.composeProvider(providerId);
		const virtualModels = [...(this.virtualModels.get(providerId)?.values() ?? [])].map((entry) => entry.model);
		if (virtualModels.length > 0) this.models.setProvider(withVirtualModels(providerId, provider, virtualModels));
		else if (provider) this.models.setProvider(provider);
		else this.models.deleteProvider(providerId);
		return provider;
	}

	/** The provider without virtual models, or undefined when nothing defines it. */
	private composeProvider(providerId: string): Provider | undefined {
		const base = this.nativeExtensionProviders.get(providerId) ?? this.builtins.get(providerId);
		const extension = this.extensionProviders.get(providerId);
		if (!this.config.getProvider(providerId) && !extension) {
			// No overlays: use the builtin untouched so its auth/login/stream behavior is exact.
			this.compositionErrors.delete(providerId);
			return base;
		}
		try {
			const provider = composeModelProvider(providerId, base, this.config, extension, this.known);
			this.compositionErrors.delete(providerId);
			return provider;
		} catch (error) {
			this.compositionErrors.set(providerId, errorMessage(error));
			return base;
		}
	}

	/** Recompose every provider; the caller updates its model snapshot. */
	rebuildProviders(): void {
		this.models.clearProviders();
		this.compositionErrors.clear();
		for (const providerId of this.providerIds()) this.recomposeProvider(providerId);
	}

	/** Store an extension registration and return the effective configuration. */
	setExtensionProvider(providerId: string, config: ProviderConfigInput): ProviderConfigInput {
		// Validate the incoming registration on its own, like the legacy registry:
		// a broken re-registration must throw without touching the stored config.
		validateExtensionProvider(providerId, this.builtins.get(providerId), this.config.getProvider(providerId), config);
		this.nativeExtensionProviders.delete(providerId);
		// Re-registration merges defined values over the previous registration and
		// preserves undefined ones, matching the legacy ModelRegistry contract.
		const previous = this.extensionProviders.get(providerId);
		const effective: ProviderConfigInput = { ...previous };
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
		}
		this.extensionProviders.set(providerId, effective);
		return effective;
	}

	/** Store a virtual model; throws when the id belongs to a physical model of that provider. */
	addVirtualModel(definition: VirtualModelDefinition): void {
		const { provider: providerId, id } = definition;
		if (!providerId.trim() || !id.trim()) throw new Error("Virtual model provider and id must not be empty.");
		const existing = this.models.getModel(providerId, id);
		if (existing && !isVirtualModel(existing)) {
			throw new Error(`Virtual model ${providerId}/${id} conflicts with a physical model.`);
		}
		const models = this.virtualModels.get(providerId) ?? new Map<string, RegisteredVirtualModel>();
		models.set(id, { model: createVirtualModel(definition), route: (request) => definition.route(request) });
		this.virtualModels.set(providerId, models);
	}

	/** Remove a virtual model; returns false when it was not registered. */
	removeVirtualModel(providerId: string, id: string): boolean {
		const models = this.virtualModels.get(providerId);
		if (!models?.delete(id)) return false;
		if (models.size === 0) this.virtualModels.delete(providerId);
		return true;
	}

	getVirtualModel(providerId: string, id: string): RegisteredVirtualModel | undefined {
		return this.virtualModels.get(providerId)?.get(id);
	}

	/** models.json and composition errors, in the order `ModelRuntime.getError()` reports them. */
	getErrors(): string[] {
		const errors: string[] = [];
		const configError = this.config.getError();
		if (configError) errors.push(configError);
		for (const [providerId, error] of this.compositionErrors) {
			errors.push(`Provider "${providerId}": ${error}`);
		}
		return errors;
	}
}
