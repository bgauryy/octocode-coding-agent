import {
	type AnyModel,
	type Api,
	type AssistantImages,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AuthCheck,
	type AuthOperationOptions,
	type AuthResult,
	type ClassifierApi,
	type ClassifierContext,
	type ClassifierModel,
	type ClassifierResult,
	type Context,
	type Credential,
	type CredentialInfo,
	createModels,
	type DeferredHandle,
	type ImageApi,
	type ImageModel,
	type ImagesContext,
	type Message,
	type Model,
	type Models,
	type ModelsApiStreamOptions,
	type ModelsClassifierOptions,
	type ModelsDeferredCancelOptions,
	type ModelsDeferredFetchOptions,
	type ModelsImagesOptions,
	type ModelsRefreshOptions,
	type ModelsRefreshResult,
	type ModelsStore,
	type ModelThinkingLevel,
	type ModelType,
	type ModelTypeMap,
	type MutableModels,
	type Provider,
	type StreamOptions,
} from "@octocodeai/octocode-ai";
import type { CachePreferenceLayer } from "@octocodeai/octocode-ai/utils/cache-policy";
import { dirname } from "node:path";
import { resolveConfiguredCache } from "./cache-configuration.ts";
import type { ModelConfig } from "./model-config.ts";
import { ModelAvailability } from "./model-runtime/availability.ts";
import { loadModelRuntimeParts, refreshOnCreate } from "./model-runtime/create.ts";
import { CredentialOperations } from "./model-runtime/credential-operations.ts";
import { refreshModelRuntime } from "./model-runtime/refresh.ts";
import { ProviderRegistrations } from "./model-runtime/registrations.ts";
import { ProviderLayers } from "./model-runtime/provider-layers.ts";
import {
	cancelDeferredResponse,
	classifyWithModel,
	generateModelImages,
	resolveModelAuth,
	type RuntimeSimpleStreamOptions,
	streamChatModel,
	streamDeferredResponse,
	streamSimpleChatModel,
} from "./model-runtime/requests.ts";
import { type CreateModelRuntimeOptions, type ModelRuntimeAuthOverrides } from "./model-runtime/types.ts";
import { routeVirtualModel } from "./model-runtime/virtual-routing.ts";
import {
	type AuthStatus,
	type CompatibilityRequestConfig,
	type ProviderConfigInput,
	resolveCompatibilityRequestConfig,
} from "./provider-composer.ts";
import type { RuntimeCredentials } from "./runtime-credentials.ts";
import {
	isVirtualModel,
	type ModelRoute,
	type ModelRouteReason,
	type VirtualModelDefinition,
} from "./virtual-models.ts";

export {
	type CreateModelRuntimeOptions,
	CredentialSynchronizationError,
	type CredentialSynchronizationOperation,
	type ModelRuntimeAuthOverrides,
	type ModelRuntimeLoginOptions,
} from "./model-runtime/types.ts";

/** Configured octocode-ai Models collection used by coding-agent and SDK consumers. */
export class ModelRuntime implements Models {
	private readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	private readonly layers: ProviderLayers;
	private readonly modelsPath: string | undefined;
	private readonly modelNetworkEnabled: boolean;
	private readonly availability: ModelAvailability;
	private readonly credentialOperations: CredentialOperations;
	private readonly registrations: ProviderRegistrations;

	private constructor(
		credentials: RuntimeCredentials,
		config: ModelConfig,
		modelsPath: string | undefined,
		modelsStore: ModelsStore,
		providers: readonly Provider[],
		modelNetworkEnabled: boolean,
	) {
		this.credentials = credentials;
		this.modelsPath = modelsPath;
		this.modelNetworkEnabled = modelNetworkEnabled;
		this.models = createModels({ credentials, modelsStore });
		this.layers = new ProviderLayers(this.models, config, providers);
		this.availability = new ModelAvailability(this.models, credentials);
		this.credentialOperations = new CredentialOperations({
			models: this.models,
			credentials,
			layers: this.layers,
			availability: this.availability,
		});
		this.registrations = new ProviderRegistrations(this.layers, this.availability, () => {
			void this.refresh({ allowNetwork: false });
		});
		this.rebuildProviders();
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const { credentials, config, modelsPath, modelsStore, providers } = await loadModelRuntimeParts(options);
		const runtime = new ModelRuntime(
			credentials,
			config,
			modelsPath,
			modelsStore,
			providers,
			process.env.OCTOCODE_OFFLINE === undefined,
		);
		runtime.rebuildProviders();
		await refreshOnCreate((refreshOptions) => runtime.refresh(refreshOptions), runtime.modelNetworkEnabled, options);
		return runtime;
	}

	private rebuildProviders(): void {
		this.layers.rebuildProviders();
		this.availability.updateModelSnapshot();
	}

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

	getAvailableSnapshot(): readonly Model<Api>[] {
		return this.availability.snapshot.available;
	}

	getError(): string | undefined {
		const errors = this.layers.getErrors();
		const availabilityError = this.availability.availabilityError;
		if (availabilityError) errors.push(`Availability refresh: ${availabilityError}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
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

	getAuth(providerId: string, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: ModelRuntimeAuthOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | AnyModel,
		overrides: ModelRuntimeAuthOverrides = {},
	): Promise<AuthResult | undefined> {
		if (typeof providerOrModel === "string") return this.models.getAuth(providerOrModel, overrides);
		return resolveModelAuth(this.models, this.layers, providerOrModel, overrides);
	}

	setRuntimeApiKey(providerId: string, apiKey: string, options: AuthOperationOptions = {}): Promise<void> {
		return this.credentialOperations.setRuntimeApiKey(providerId, apiKey, options);
	}

	removeRuntimeApiKey(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		return this.credentialOperations.removeRuntimeApiKey(providerId, options);
	}

	listCredentials(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return this.credentials.list(options);
	}
	importCredential(...args: Parameters<CredentialOperations["importCredential"]>): Promise<void> {
		return this.credentialOperations.importCredential(...args);
	}
	getProviderAuthStatus(providerId: string): AuthStatus {
		return this.availability.getProviderAuthStatus(providerId, this.credentials, this.layers);
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return streamChatModel(this, model, context, options);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: RuntimeSimpleStreamOptions): AssistantMessageEventStream {
		return streamSimpleChatModel(this, model, context, options);
	}

	completeSimple(model: Model<Api>, context: Context, options?: RuntimeSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return streamDeferredResponse(this, model, handle, options);
	}

	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.streamDeferred(model, handle, options).result();
	}

	async cancelDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredCancelOptions,
	): Promise<void> {
		await cancelDeferredResponse(this, model, handle, options);
	}

	async generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		return generateModelImages(this, model, context, options);
	}

	async classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		return classifyWithModel(this, model, context, options);
	}

	login(...args: Parameters<CredentialOperations["login"]>): Promise<Credential> {
		return this.credentialOperations.login(...args);
	}

	logout(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		return this.credentialOperations.logout(providerId, options);
	}

	refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		const { models, layers, availability, modelsPath, modelNetworkEnabled } = this;
		return refreshModelRuntime({ models, layers, availability, modelsPath, modelNetworkEnabled }, options);
	}

	registerNativeProvider(provider: Provider): void {
		this.registrations.registerNativeProvider(provider);
	}

	registerProvider(providerId: string, config: ProviderConfigInput): void {
		this.registrations.registerProvider(providerId, config);
	}

	unregisterProvider(providerId: string): void {
		this.registrations.unregisterProvider(providerId);
	}

	/**
	 * Register a virtual model under `definition.provider`, which may also list physical models or
	 * several virtual models. Re-registering the same provider and id replaces the virtual model.
	 * Throws when the id belongs to a physical model of that provider.
	 */
	registerVirtualModel(definition: VirtualModelDefinition): void {
		this.registrations.registerVirtualModel(definition);
	}

	unregisterVirtualModel(providerId: string, id: string): void {
		this.registrations.unregisterVirtualModel(providerId, id);
	}

	/**
	 * Ask a virtual model's router for the model and thinking level of one request. The router must
	 * return a physical catalog model whose provider has credentials; the thinking level is clamped
	 * to that model. Throws when routing fails.
	 *
	 * `previous` reports the latest successful response in `messages`. A retry passes the failed
	 * response as `options.failed`; `messages` no longer contains it. `options.state` is the router
	 * state stored by the caller, which also stores the returned state.
	 */
	async resolveModel(
		model: Model<Api>,
		messages: readonly Message[],
		options: {
			reason: ModelRouteReason;
			thinkingLevel: ModelThinkingLevel;
			signal?: AbortSignal;
			failed?: AssistantMessage;
			state?: unknown;
		},
	): Promise<ModelRoute> {
		return routeVirtualModel(this, this.layers.getVirtualModel(model.provider, model.id), model, messages, options);
	}

	/** A catalog chat model that is not virtual. */
	getPhysicalModel(providerId: string, modelId: string): Model<Api> | undefined {
		const model = this.models.getModel(providerId, modelId);
		return model && !isVirtualModel(model) ? model : undefined;
	}
}
