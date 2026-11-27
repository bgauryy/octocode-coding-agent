import {
	isModelAccessError,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AnyModel,
	type Api,
	type AuthOperationOptions,
	type AuthCheck,
	type Model,
	type ModelType,
	type ModelTypeMap,
	type MutableModels,
	type Provider,
	type ProviderPlan,
	type StreamOptions,
} from "@octocodeai/octocode-ai";
import type { CachePreferenceLayer } from "@octocodeai/octocode-ai/utils/cache-policy";
import { dirname } from "node:path";
import { isLoopbackIp } from "@octocodeai/octocode-common/ip-address";
import { resolveConfiguredCache } from "../cache-configuration.ts";
import {
	type CompatibilityRequestConfig,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
} from "../provider-composer.ts";
import type { CatalogUpdate } from "../model-catalog/merge.ts";
import { catalogUpdateOf } from "../model-catalog/provider.ts";
import { allowsUnattended, isSubscriptionBilled } from "../subscription.ts";
import type { ModelAvailability } from "./availability.ts";
import type { ProviderLayers } from "./provider-layers.ts";
import { configuredRequestsPerMinute, configuredTokensPerMinute } from "./request-rate.ts";

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
	/** A provider may accept a credential while refusing one particular model or regional profile. */
	private readonly refused = new Map<string, Map<string, number>>();

	private accessGeneration = 0;
	/** Requests which began before a credential or endpoint change cannot update the new account's availability. */
	get modelAccessGeneration(): number {
		return this.accessGeneration;
	}

	setModelAccess(model: { provider: string; id: string }, rejected: boolean, generation = this.accessGeneration): void {
		if (generation !== this.accessGeneration) return;
		const entries = this.refused.get(model.provider);
		if (!rejected) {
			entries?.delete(model.id);
			if (!entries?.size) this.refused.delete(model.provider);
			return;
		}
		const current = entries ?? new Map<string, number>();
		current.set(model.id, Date.now() + 5 * 60_000);
		this.refused.set(model.provider, current);
	}

	protected clearModelAccess(provider?: string): void {
		this.accessGeneration++;
		if (provider === undefined) this.refused.clear();
		else this.refused.delete(provider);
	}

	isModelAccessRejected(model: { provider: string; id: string }): boolean {
		const until = this.refused.get(model.provider)?.get(model.id);
		if (until === undefined) return false;
		if (until > Date.now()) return true;
		this.setModelAccess(model, false);
		return false;
	}

	assertModelAccess(model: { provider: string; id: string }): void {
		if (this.isModelAccessRejected(model)) {
			throw new Error(
				`The provider recently refused ${model.provider}/${model.id}. Choose another model in /model or recheck access in /providers.`,
			);
		}
	}

	observeModelAccess(message: AssistantMessage, generation = this.accessGeneration): void {
		const model = { provider: message.provider, id: message.model };
		if (message.stopReason === "error") {
			if (isModelAccessError(message.errorMessage ?? "")) this.setModelAccess(model, true, generation);
		} else if (message.stopReason !== "aborted") this.setModelAccess(model, false, generation);
	}

	protected observeStream(stream: AssistantMessageEventStream): AssistantMessageEventStream {
		// The terminal result is also available to the stream consumer and never consumes a delta.
		const generation = this.accessGeneration;
		void stream.result().then((message) => this.observeModelAccess(message, generation));
		return stream;
	}

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

	/** Where a model's provider limit falls back to when models.json sets none: the `requestsPerMinute` setting. */
	defaultRequestsPerMinute: () => number | undefined = () => undefined;

	/** Sends per minute for the model's provider: its models.json entry, else its provider's, else the setting. */
	requestsPerMinute(model: Model<Api>): number | undefined {
		return (
			configuredRequestsPerMinute(this.layers.config.getProvider(model.provider), model.id) ??
			this.defaultRequestsPerMinute()
		);
	}

	/** The models.json token budget per minute for the model's gated requests; undefined: the gate's default. */
	tokensPerMinute(model: Model<Api>): number | undefined {
		return configuredTokensPerMinute(this.layers.config.getProvider(model.provider), model.id);
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
		const models = await this.models.getAvailableOfType(type, providerId, options);
		return this.availableRoutes(this.availability.visible(models));
	}

	async getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		const models = await this.models.getAllAvailable(providerId, options);
		return this.availableRoutes(this.availability.visible(models));
	}

	async checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		return this.models.checkAuth(providerId, options);
	}

	async getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		return this.availableRoutes(await this.availability.getAvailable(providerId, options));
	}

	setHiddenModels(hidden: Readonly<Record<string, readonly string[]>>): void {
		this.availability.setHiddenModels(hidden);
	}

	setDisabledProviders(providerIds: readonly string[]): void {
		this.availability.setDisabledProviders(providerIds);
	}

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.availableRoutes(this.availability.snapshot.available);
	}

	/**
	 * The provider's plan facts. A models.json or feature overlay recomposes a provider without them, so the built-in
	 * (or native feature) definition answers when the composed one does not.
	 */
	getProviderPlan(providerId: string): ProviderPlan | undefined {
		return (
			this.models.getProvider(providerId)?.auth.plan ??
			(this.layers.nativeFeatureProviders.get(providerId) ?? this.layers.builtins.get(providerId))?.auth.plan
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
	private availableRoutes<T extends { provider: string; id: string }>(models: readonly T[]): readonly T[] {
		const paused = new Set(
			this.getProviders()
				.map((provider) => provider.id)
				.filter((providerId) => this.getPlanDisabledReason(providerId) !== undefined),
		);
		return paused.size === 0 && this.refused.size === 0
			? models
			: models.filter((model) => !paused.has(model.provider) && !this.isModelAccessRejected(model));
	}

	getRegisteredProviderConfig(providerId: string): ProviderConfigInput | undefined {
		return this.layers.featureProviders.get(providerId);
	}

	getRegisteredProviderIds(): readonly string[] {
		return [...new Set([...this.layers.featureProviders.keys(), ...this.layers.nativeFeatureProviders.keys()])];
	}

	getRegisteredNativeProvider(providerId: string): Provider | undefined {
		return this.layers.nativeFeatureProviders.get(providerId);
	}

	/** @internal Compatibility fallback for ModelRegistry when provider auth is unconfigured. */
	getCompatibilityRequestConfig(model: Model<Api>): CompatibilityRequestConfig {
		return resolveCompatibilityRequestConfig(
			model,
			this.layers.config.getProvider(model.provider),
			this.layers.featureProviders.get(model.provider),
		);
	}

	isUsingOAuth(providerId: string, scope?: "child"): boolean {
		return this.availability.authType(providerId, scope) === "oauth";
	}

	/**
	 * The one billing test: the footer's `(sub)`, the cache description, `/providers` and `models` all answer from it.
	 * A provider whose plan bills by plan counts for every credential; otherwise a subscription OAuth login does.
	 */
	isUsingSubscription(providerId: string, scope?: "child"): boolean {
		return isSubscriptionBilled({
			plan: this.getProviderPlan(providerId),
			usingOAuth: this.isUsingOAuth(providerId, scope),
			oauthIsSubscription: this.models.getProvider(providerId)?.auth.oauth?.isSubscription === true,
		});
	}

	/**
	 * What a request through the provider costs the user, from the same test: `plan` when a subscription pays for it
	 * (its marginal cost is the plan, not the metered list price), else `metered`. Model routing ranks by it.
	 */
	getProviderBilling(providerId: string, scope?: "child"): ProviderPlan["billing"] {
		return this.isUsingSubscription(providerId, scope) ? "plan" : "metered";
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

	/**
	 * What the models.dev catalog update changed for a built-in model: `deprecated` (dim it, never route or fall back to
	 * it), `source: "models.dev"` (added at runtime, not shipped: the picker's "new" mark), `repriced`. Undefined for a
	 * model it left as bundled, a models.json model, or before the first catalog refresh. Reads memory only.
	 */
	getCatalogUpdate(model: { provider: string; id: string }): CatalogUpdate | undefined {
		return catalogUpdateOf(this.layers.builtins.get(model.provider), model.id);
	}

	/** True when models.dev lists the built-in model as deprecated (`getCatalogUpdate`): skip it in fallback and choice. */
	isModelDeprecated(model: { provider: string; id: string }): boolean {
		return this.getCatalogUpdate(model)?.deprecated === true;
	}

	/** True when the user unticked the model on its provider's page. */
	isModelHidden(model: { provider: string; id: string }): boolean {
		return this.availability.isModelHidden(model);
	}
	isModelAvailableToChild(model: Pick<Model<Api>, "provider" | "id">): boolean {
		return this.availability.isModelAvailableToChild(model);
	}

	isProviderDisabled(providerId: string): boolean {
		return this.availability.isProviderDisabled(providerId);
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.availability.snapshot.configuredProviders.has(providerId);
	}
}
