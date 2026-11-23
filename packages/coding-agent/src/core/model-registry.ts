import type {
	Api,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEventStream,
	AuthOperationOptions,
	AuthResult,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Context,
	ImageApi,
	ImageModel,
	ImagesContext,
	Model,
	ModelsApiStreamOptions,
	ModelsClassifierOptions,
	ModelsImagesOptions,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	ModelsSimpleStreamOptions,
	ModelType,
	ModelTypeMap,
	Provider,
	ProviderHeaders,
	ProviderPlan,
} from "@octocodeai/octocode-ai";
import type { CachePreferenceLayer, CachePreferences } from "@octocodeai/octocode-ai/utils/cache-policy";
import type { CatalogUpdate } from "./model-catalog/merge.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ModelOrigin } from "./model-runtime/provider-layers.ts";
import type { CredentialKind, ProviderKind } from "./model-runtime/catalog.ts";
import type { AuthStatus, ProviderConfigInput } from "./provider-composer.ts";
import type { VirtualModelDefinition } from "./virtual-models.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";

export type { ProviderConfigInput } from "./provider-composer.ts";
export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: ProviderHeaders;
			baseUrl?: string;
			env?: Record<string, string>;
	  }
	| { ok: false; error: string };

/**
 * Synchronous compatibility facade exposed to features.
 * Coding-agent internals use ModelRuntime directly.
 */
export class ModelRegistry {
	private readonly runtime: ModelRuntime;

	constructor(runtime: ModelRuntime) {
		this.runtime = runtime;
	}

	/** Reload models.json asynchronously. Await before making synchronous registry reads. */
	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		return this.runtime.refresh(options);
	}

	getError(): string | undefined {
		return this.runtime.getError();
	}

	getCachePolicy(model: Model<Api>, settings?: readonly CachePreferenceLayer[], options?: CachePreferences) {
		return this.runtime.getCachePolicy(model, options, settings);
	}

	getAll(): Model<Api>[] {
		return [...this.runtime.getModels()];
	}

	isProviderDisabled(provider: string): boolean {
		return this.runtime.isProviderDisabled(provider);
	}

	isModelAccessRejected(model: Pick<Model<Api>, "provider" | "id">): boolean {
		return this.runtime.isModelAccessRejected(model);
	}

	isModelHidden(model: Pick<Model<Api>, "provider" | "id">): boolean {
		return this.runtime.isModelHidden(model);
	}
	isModelAvailableToChild(model: Pick<Model<Api>, "provider" | "id">): boolean {
		return this.runtime.isModelAvailableToChild(model);
	}

	/** What the models.dev catalog update changed for a built-in model (`ModelRuntime.getCatalogUpdate`); undefined when nothing. */
	getCatalogUpdate(model: Pick<Model<Api>, "provider" | "id">): CatalogUpdate | undefined {
		return this.runtime.getCatalogUpdate(model);
	}

	/** True when models.dev lists the built-in model as deprecated: pickers dim it, routing and fallback skip it. */
	isModelDeprecated(model: Pick<Model<Api>, "provider" | "id">): boolean {
		return this.runtime.isModelDeprecated(model);
	}

	getAvailable(): Model<Api>[] {
		return [...this.runtime.getAvailableSnapshot()];
	}

	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.runtime.getModel(provider, modelId);
	}

	/** Find a model of a non-chat type, e.g. `findOfType("classifier", "typesafe", "jev-latest")`. */
	findOfType<TType extends ModelType>(type: TType, provider: string, modelId: string): ModelTypeMap[TType] | undefined {
		return this.runtime.getModelOfType(type, provider, modelId);
	}

	hasConfiguredAuth(model: Model<Api>): boolean {
		return this.runtime.hasConfiguredAuth(model.provider);
	}

	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const resolution = await this.runtime.getAuth(model);
			if (!resolution) {
				const compatibility = this.runtime.getCompatibilityRequestConfig(model);
				if (compatibility.authHeader) {
					return { ok: false, error: `No API key found for "${model.provider}"` };
				}
				return { ok: true, headers: compatibility.headers };
			}
			return {
				ok: true,
				apiKey: resolution.auth.apiKey,
				headers: resolution.auth.headers,
				...(resolution.auth.baseUrl ? { baseUrl: resolution.auth.baseUrl } : {}),
				env: resolution.env,
			};
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			const message = cause instanceof Error ? cause.message : errorMessage(error);
			return {
				ok: false,
				error:
					message === "authHeader requires a resolved API key" ? `No API key found for "${model.provider}"` : message,
			};
		}
	}

	getProviderAuthStatus(provider: string): AuthStatus {
		return this.runtime.getProviderAuthStatus(provider);
	}

	getProvider(provider: string): Provider | undefined {
		return this.runtime.getProvider(provider);
	}

	/** Whether usage is paid by a subscription, so a cost figure is an estimate of API value, not a bill. */
	billedBySubscription(provider: string, scope?: "child"): boolean {
		return this.runtime.isUsingSubscription(provider, scope);
	}

	/** Stream through the configured provider with request-time authentication. */
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return this.runtime.stream(model, context, options);
	}

	/** Stream with provider-neutral options and request-time authentication. */
	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return this.runtime.streamSimple(model, context, options);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.runtime.complete(model, context, options);
	}

	/** Every known model of a type (chat, image, classifier), optionally for one provider. */
	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][] {
		return this.runtime.getModelsOfType(type, provider);
	}

	/** Models of a type whose provider has working credentials. */
	getAvailableOfType<TType extends ModelType>(
		type: TType,
		provider?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return this.runtime.getAvailableOfType(type, provider, options);
	}

	getModelOfType<TType extends ModelType>(
		type: TType,
		provider: string,
		modelId: string,
	): ModelTypeMap[TType] | undefined {
		return this.runtime.getModelOfType(type, provider, modelId);
	}

	/** Classify structured state with request-time authentication. Never rejects. */
	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		return this.runtime.classify(model, context, options);
	}

	/** Generate images with request-time authentication. Never rejects. */
	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		return this.runtime.generateImages(model, context, options);
	}

	getProviderDisplayName(provider: string): string {
		return this.runtime.getProvider(provider)?.name ?? provider;
	}

	getProviderAuth(provider: string): Promise<AuthResult | undefined> {
		return this.runtime.getAuth(provider);
	}

	/** The provider's API key; undefined only when none is configured. A credential that fails to resolve (a failing `!command`, a keychain error) rejects. */
	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		return (await this.runtime.getAuth(provider))?.auth.apiKey;
	}

	getCredentialKind(provider: string): Promise<CredentialKind> {
		return this.runtime.getCredentialKind(provider);
	}

	/** The provider's kind for display: subscription, API key, account, CLI or local (see `ModelRuntime`). */
	getProviderKind(provider: string): ProviderKind {
		return this.runtime.getProviderKind(provider);
	}

	/** "plan" when a subscription pays for this provider's requests, else "metered" (see `ProviderPlan`). */
	getProviderBilling(provider: string, scope?: "child"): ProviderPlan["billing"] {
		return this.runtime.getProviderBilling(provider, scope);
	}

	/** False for a plan whose vendor allows only interactive use: automatic background routing skips it. */
	allowsUnattendedUse(provider: string): boolean {
		return this.runtime.allowsUnattendedUse(provider);
	}

	getModelOrigin(model: Model<Api>): ModelOrigin {
		return this.runtime.getModelOrigin(model);
	}

	isUsingOAuth(model: Model<Api>): boolean {
		return this.runtime.isUsingOAuth(model.provider);
	}

	registerProvider(provider: Provider): void;
	registerProvider(providerName: string, config: ProviderConfigInput): void;
	registerProvider(providerOrName: Provider | string, config?: ProviderConfigInput): void {
		if (typeof providerOrName === "string") {
			if (!config) throw new Error("Provider config is required when registering by name");
			this.runtime.registerProvider(providerOrName, config);
			return;
		}
		this.runtime.registerNativeProvider(providerOrName);
	}

	unregisterProvider(providerName: string): void {
		this.runtime.unregisterProvider(providerName);
	}

	registerVirtualModel(definition: VirtualModelDefinition): void {
		this.runtime.registerVirtualModel(definition);
	}

	unregisterVirtualModel(providerName: string, id: string): void {
		this.runtime.unregisterVirtualModel(providerName, id);
	}

	getRegisteredProviderConfig(providerName: string): ProviderConfigInput | undefined {
		return this.runtime.getRegisteredProviderConfig(providerName);
	}

	getRegisteredNativeProvider(providerName: string): Provider | undefined {
		return this.runtime.getRegisteredNativeProvider(providerName);
	}

	getRegisteredProviderIds(): readonly string[] {
		return this.runtime.getRegisteredProviderIds();
	}
}
