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
	ProviderPlan,
	StreamOptions,
} from "@octocodeai/octocode-ai";
import type { CachePreferenceLayer } from "@octocodeai/octocode-ai/utils/cache-policy";
import { dirname } from "node:path";
import { isLoopbackIp } from "../../../../common/src/ip-address.ts";
import { resolveConfiguredCache } from "../cache-configuration.ts";
import {
	type CompatibilityRequestConfig,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
} from "../provider-composer.ts";
import { allowsUnattended, isSubscriptionBilled } from "../subscription.ts";
import type { ModelAvailability } from "./availability.ts";
import type { ProviderLayers } from "./provider-layers.ts";

/** How a provider is signed in: a stored account login, a subscription (login or token), or a key. */
export type CredentialKind = "account" | "subscription" | "key";

/**
 * What a provider is to the user, the one word every view shows beside it: a vendor `CLI`, a `subscription` (a plan
 * sign-in or plan key), another `account` login, a `local` model server on this machine, or a metered `API key`.
 */
export type ProviderKind = "subscription" | "API key" | "account" | "CLI" | "local";

/** Whether a model's base URL names this machine (localhost, 127.0.0.0/8, ::1). */
function isLoopbackUrl(baseUrl: string): boolean {
	if (!URL.canParse(baseUrl)) return false;
	const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
	return host === "localhost" || isLoopbackIp(host);
}

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

	async getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return this.withoutPausedPlans(await this.models.getAvailableOfType(type, providerId, options));
	}

	async getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		return this.withoutPausedPlans(await this.models.getAllAvailable(providerId, options));
	}

	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId, options);
	}

	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		return this.withoutPausedPlans(await this.availability.getAvailable(providerId, options));
	}

	setDisabledProviders(providerIds: readonly string[]): void {
		this.availability.setDisabledProviders(providerIds);
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.withoutPausedPlans(this.availability.snapshot.available);
	}

	/**
	 * The provider's plan facts. A models.json or extension overlay recomposes a provider without them, so the built-in
	 * (or native extension) definition answers when the composed one does not.
	 */
	getProviderPlan(providerId: string): ProviderPlan | undefined {
		return (
			this.models.getProvider(providerId)?.auth.plan ??
			(this.layers.nativeExtensionProviders.get(providerId) ?? this.layers.builtins.get(providerId))?.auth.plan
		);
	}

	/** Why the provider's plan route is paused (its kill switch), or undefined. Its models are unavailable meanwhile. */
	getPlanDisabledReason(providerId: string): string | undefined {
		return this.getProviderPlan(providerId)?.disabled || undefined;
	}

	/**
	 * False when the vendor allows the plan in interactive use only. Automatic model choice for an unattended run (print
	 * mode, an ACP server's session, a background child) then skips the provider; a model the user names still runs, with
	 * a notice.
	 */
	allowsUnattendedUse(providerId: string): boolean {
		return allowsUnattended(this.getProviderPlan(providerId));
	}

	/** Models whose provider's plan is paused leave every availability answer; credentials and the catalog stay. */
	private withoutPausedPlans<T extends { provider: string }>(models: readonly T[]): readonly T[] {
		const paused = new Set(
			this.getProviders()
				.map((provider) => provider.id)
				.filter((providerId) => this.getPlanDisabledReason(providerId) !== undefined),
		);
		return paused.size === 0 ? models : models.filter((model) => !paused.has(model.provider));
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

	/**
	 * The one billing test: the footer's `(sub)`, the cache description, `/providers` and `models` all answer from it.
	 * A provider whose plan bills by plan counts for every credential; otherwise a subscription OAuth login does.
	 */
	isUsingSubscription(providerId: string): boolean {
		return isSubscriptionBilled({
			plan: this.getProviderPlan(providerId),
			usingOAuth: this.isUsingOAuth(providerId),
			oauthIsSubscription: this.models.getProvider(providerId)?.auth.oauth?.isSubscription === true,
		});
	}

	/**
	 * What a request through the provider costs the user, from the same test: `plan` when a subscription pays for it
	 * (its marginal cost is the plan, not the metered list price), else `metered`. Model routing ranks by it.
	 */
	getProviderBilling(providerId: string): ProviderPlan["billing"] {
		return this.isUsingSubscription(providerId) ? "plan" : "metered";
	}

	/**
	 * The provider's kind, in order: a plan that runs through the vendor's CLI is `CLI`; whatever `isUsingSubscription`
	 * counts (a sign-in plan, a plan key) is `subscription`; another stored login is `account`; a provider whose every
	 * model is served from this machine is `local`; anything else is a metered `API key` (auth.json, keychain,
	 * models.json or the environment). Answers from local facts only, never a request.
	 */
	getProviderKind(providerId: string): ProviderKind {
		const facts = this.credentialFacts(providerId);
		if (facts.cli) return "CLI";
		if (facts.subscription) return "subscription";
		if (facts.oauth) return "account";
		const models = this.models.getModels(providerId);
		return models.length > 0 && models.every((model) => isLoopbackUrl(model.baseUrl)) ? "local" : "API key";
	}

	/**
	 * Which kind of credential a provider uses, from the facts `getProviderKind` reads: a subscription, another stored
	 * login (`account`), anything else a `key`. Async for callers that await it; the answer needs no request.
	 */
	async getCredentialKind(providerId: string): Promise<CredentialKind> {
		const facts = this.credentialFacts(providerId);
		return facts.subscription ? "subscription" : facts.oauth ? "account" : "key";
	}

	private credentialFacts(providerId: string): { cli: boolean; subscription: boolean; oauth: boolean } {
		return {
			cli: this.getProviderPlan(providerId)?.transport === "cli",
			subscription: this.isUsingSubscription(providerId),
			oauth: this.isUsingOAuth(providerId),
		};
	}

	isProviderDisabled(providerId: string): boolean {
		return this.availability.isProviderDisabled(providerId);
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.availability.snapshot.configuredProviders.has(providerId);
	}
}
