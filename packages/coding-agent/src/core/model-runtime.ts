import {
	type AnyModel,
	type Api,
	type AssistantImages,
	type AssistantMessage,
	type AssistantMessageEventStream,
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
	type ModelsRefreshResult,
	type ModelThinkingLevel,
	type MutableModels,
	type Provider,
} from "@octocodeai/octocode-ai";
import type { ModelConfig } from "./model-config.ts";
import type { ModelsProject } from "./model-config/project.ts";
import { missingCredentialWarning } from "./model-runtime/missing-credentials.ts";
import { ProviderPins } from "./model-runtime/provider-pins.ts";
import { loadSettledConfig } from "./model-runtime/settled-config.ts";
import { ModelCatalog } from "./model-runtime/catalog.ts";
import { ModelAvailability } from "./model-runtime/availability.ts";
import { loadModelRuntimeParts, type ModelRuntimeParts, refreshOnCreate } from "./model-runtime/create.ts";
import { CredentialOperations } from "./model-runtime/credential-operations.ts";
import { CredentialNetworkRefresh } from "./model-runtime/credential-refresh.ts";
import { RuntimeLiveReload } from "./model-runtime/live-reload.ts";
import { refreshModelRuntime, type RuntimeRefreshOptions } from "./model-runtime/refresh.ts";
import { ReloadErrors } from "./model-runtime/reload-errors.ts";
import { ProviderRegistrations } from "./model-runtime/registrations.ts";
import { type ModelOrigin, ProviderLayers } from "./model-runtime/provider-layers.ts";
import {
	cancelDeferredResponse,
	classifyWithModel,
	generateModelImages,
	type ModelRequestHost,
	resolveModelAuth,
	type RuntimeSimpleStreamOptions,
	streamChatModel,
	streamDeferredResponse,
	streamSimpleChatModel,
} from "./model-runtime/requests.ts";
import { type CreateModelRuntimeOptions, type ModelRuntimeAuthOverrides } from "./model-runtime/types.ts";
import { routeVirtualModel } from "./model-runtime/virtual-routing.ts";
import { type AuthStatus, type ProviderConfigInput } from "./provider-composer.ts";
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
	type ModelRuntimeAuthOverrides,
} from "./model-runtime/types.ts";

/** Configured octocode-ai Models collection used by coding-agent and SDK consumers. */
export class ModelRuntime extends ModelCatalog implements Models {
	protected readonly models: MutableModels;
	private readonly credentials: RuntimeCredentials;
	protected readonly layers: ProviderLayers;
	protected readonly modelsPath: string | undefined;
	private readonly project: ModelsProject | undefined;
	private readonly modelNetworkEnabled: boolean;
	protected readonly availability: ModelAvailability;
	private readonly credentialOperations: CredentialOperations;
	private readonly registrations: ProviderRegistrations;
	/** Why the last provider-registration or live-reload refresh failed; getError shows it until one succeeds. */
	private readonly reloadErrors = new ReloadErrors();
	private readonly credentialRefresh = new CredentialNetworkRefresh((o) => this.refresh(o), this.reloadErrors.set);
	private readonly liveReload: RuntimeLiveReload;
	private readonly pins: ProviderPins;
	/** Serves requests whose provider a reload removed. */
	private readonly requestHost: ModelRequestHost;

	private constructor(parts: ModelRuntimeParts) {
		super();
		const { credentials, config, modelsPath, modelsStore, providers, project } = parts;
		this.project = project;
		this.credentials = credentials;
		this.modelsPath = modelsPath;
		this.modelNetworkEnabled = parts.modelNetworkEnabled;
		this.models = createModels({ credentials, modelsStore });
		this.pins = new ProviderPins(credentials);
		this.requestHost = this.pins.host(this);
		this.layers = new ProviderLayers(this.models, config, providers);
		this.availability = new ModelAvailability(this.models, credentials);
		this.credentialRefresh.enabled = parts.refreshAfterCredentialChange;
		this.credentialOperations = new CredentialOperations({
			models: this.models,
			credentials,
			layers: this.layers,
			availability: this.availability,
			clearModelAccess: (providerId) => this.clearModelAccess(providerId),
			credentialSaved: (providerId) => this.credentialRefresh.schedule(providerId),
		});
		this.registrations = new ProviderRegistrations(this.layers, this.availability, () => {
			this.refresh({ allowNetwork: false }).then(() => this.reloadErrors.set(undefined), this.reloadErrors.set);
		});
		this.rebuildProviders();
		this.liveReload = new RuntimeLiveReload({
			modelsPath,
			project,
			credentials,
			reload: async () => {
				// A change to a models.json (global or project) or auth.json reloads once; only a settled, parsed file applies.
				const next = await loadSettledConfig(this.modelsPath, undefined, this.project);
				if (next.isUnreadable()) return this.reloadErrors.set(next.getError());
				await this.applyRefresh({ allowNetwork: false }, next);
				this.clearModelAccess();
				this.reloadErrors.set(this.layers.config.getError());
			},
			onError: this.reloadErrors.set,
		});
	}

	static async create(options: CreateModelRuntimeOptions = {}): Promise<ModelRuntime> {
		const runtime = new ModelRuntime(await loadModelRuntimeParts(options));
		try {
			runtime.rebuildProviders();
			await refreshOnCreate((refreshOptions) => runtime.refresh(refreshOptions), runtime.modelNetworkEnabled, options);
			return runtime;
		} catch (error) {
			runtime.dispose();
			throw error;
		}
	}

	/** Stop watching models.json and the credential file; requests and the last availability snapshot stay. Idempotent. */
	dispose(): void {
		this.credentialRefresh.dispose();
		this.liveReload.dispose();
		this.reloadErrors.clearListeners();
		this.pins.clearListeners();
	}

	private rebuildProviders(): void {
		this.layers.rebuildProviders();
		this.availability.updateModelSnapshot();
	}

	/** A built-in provider as shipped, before models.json and features (what a `models.json` entry can inherit from). */
	getBuiltinProvider(providerId: string): Provider | undefined {
		return this.layers.builtins.get(providerId);
	}

	/** The providers the merged models.json files define (Octocode's, the legacy `~/.octocode` folders' and Pi's). */
	getDefinedProviderIds(): readonly string[] {
		return this.layers.config.getProviderIds();
	}

	/** The models.json file defining the provider; undefined for a built-in or feature provider. */
	getProviderDefinitionFile(providerId: string): string | undefined {
		return this.layers.config.getProviderFile(providerId);
	}

	/** Where the model's facts come from (see `ProviderLayers.modelOrigin`). */
	getModelOrigin(model: Pick<Model<Api>, "provider" | "id" | "api">): ModelOrigin {
		return this.layers.modelOrigin(model.provider, model.id, model.api);
	}

	hasContextWindowOverride(providerId: string, modelId: string): boolean {
		return this.layers.hasContextWindowOverride(providerId, modelId);
	}

	/** models.json fields that load but do nothing, and untrusted project files not read; each names its file. */
	getConfigWarnings(): readonly string[] {
		return this.layers.config.getWarnings();
	}

	/**
	 * One warning per enabled models.json provider that adds models but has no credential from any source (its `apiKey`,
	 * a stored key or sign-in, the environment), so none of its models can run. Read after an availability pass.
	 */
	getMissingCredentialWarnings(): string[] {
		return this.layers.config
			.getProviderIds()
			.filter(
				(providerId) =>
					(this.layers.config.getProvider(providerId)?.models?.length ?? 0) > 0 &&
					!this.isProviderDisabled(providerId) &&
					!this.hasConfiguredAuth(providerId),
			)
			.map((providerId) => missingCredentialWarning(this.layers, providerId));
	}

	/** Calls `listener` with the provider ids a reload removed. Returns the unsubscribe. */
	onProvidersRemoved(listener: (providerIds: readonly string[]) => void): () => void {
		return this.pins.onRemoved(listener);
	}

	/** Why the last live reload failed; the providers loaded before stay in use. A good reload clears it. */
	getReloadError(): string | undefined {
		return this.reloadErrors.current;
	}

	/** Calls `listener` once per new reload failure message. Returns the unsubscribe. */
	onReloadError(listener: (message: string) => void): () => void {
		return this.reloadErrors.subscribe(listener);
	}

	getError(): string | undefined {
		const errors = this.layers.getErrors();
		const availabilityError = this.availability.availabilityError;
		if (availabilityError) errors.push(`Availability refresh: ${availabilityError}`);
		if (this.reloadErrors.current) errors.push(`Model refresh: ${this.reloadErrors.current}`);
		return errors.length > 0 ? errors.join("\n\n") : undefined;
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
	/** The credential saved for a provider, with a keychain reference resolved; undefined when none. */
	readCredential(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		return this.credentials.read(providerId, options);
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
		return this.observeStream(streamChatModel(this.requestHost, model, context, options));
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: RuntimeSimpleStreamOptions): AssistantMessageEventStream {
		return this.observeStream(streamSimpleChatModel(this.requestHost, model, context, options));
	}

	completeSimple(model: Model<Api>, context: Context, options?: RuntimeSimpleStreamOptions): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return streamDeferredResponse(this.requestHost, model, handle, options);
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
		await cancelDeferredResponse(this.requestHost, model, handle, options);
	}

	async generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		return generateModelImages(this.requestHost, model, context, options);
	}

	async classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		return classifyWithModel(this.requestHost, model, context, options);
	}

	login(...args: Parameters<CredentialOperations["login"]>): Promise<Credential> {
		return this.credentialOperations.login(...args);
	}

	logout(providerId: string, options: AuthOperationOptions = {}): Promise<void> {
		return this.credentialOperations.logout(providerId, options);
	}

	refresh(options: RuntimeRefreshOptions = {}): Promise<ModelsRefreshResult> {
		return this.applyRefresh(options);
	}

	private applyRefresh(options: RuntimeRefreshOptions, config?: ModelConfig): Promise<ModelsRefreshResult> {
		const { models, layers, availability, modelsPath, project, modelNetworkEnabled, pins } = this;
		return refreshModelRuntime(
			{ models, layers, availability, modelsPath, project, modelNetworkEnabled, pins },
			options,
			config,
		);
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
	 * `previous` reports the latest successful response in `messages`. A retry passes the failed
	 * response as `options.failed`. The caller owns the router state (`options.state` and the returned state).
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
