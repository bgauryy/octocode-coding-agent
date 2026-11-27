import { defaultProviderAuthContext as defaultAuthContext } from "../auth/context.ts";
import { InMemoryCredentialStore } from "../auth/credential-store.ts";
import { type AuthResolutionOverrides, readCredential, resolveProviderAuth } from "../auth/resolve.ts";
import type {
	AuthCheck,
	AuthContext,
	AuthInteraction,
	AuthOperationOptions,
	AuthResult,
	AuthType,
	Credential,
	CredentialStore,
	LoginOptions,
} from "../auth/types.ts";
import { InMemoryModelsStore, type ModelsStore } from "../models-store.ts";
import type {
	AnyModel,
	Api,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEventStream,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Context,
	DeferredHandle,
	ImageApi,
	ImageModel,
	ImagesContext,
	Model,
	ModelType,
	ModelTypeMap,
} from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { mergeHeaders } from "../utils/headers.ts";
import { isModelType } from "../utils/model-operations.ts";
import { checkProviderAuth, loginProvider, logoutProvider } from "./auth.ts";
import type {
	CreateModelsOptions,
	ModelsApiStreamOptions,
	ModelsClassifierOptions,
	ModelsDeferredCancelOptions,
	ModelsDeferredFetchOptions,
	ModelsImagesOptions,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	ModelsSimpleStreamOptions,
	MutableModels,
	Provider,
} from "./contracts.ts";
import { ProviderModelsRefresher } from "./refresh.ts";
import { ModelRequests } from "./requests.ts";

function availableChatModels(provider: Provider, credential: Credential | undefined): readonly Model<Api>[] {
	const models = provider.getModels();
	return provider.filterModels?.(models, credential) ?? models;
}

export class ModelsImpl implements MutableModels {
	private providers = new Map<string, Provider>();
	private credentials: CredentialStore;
	private modelsStore: ModelsStore;
	private authContext: AuthContext;
	private refresher: ProviderModelsRefresher;
	private requests: ModelRequests;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.modelsStore = options?.modelsStore ?? new InMemoryModelsStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
		this.refresher = new ProviderModelsRefresher({
			getProviders: () => this.getProviders(),
			credentials: this.credentials,
			modelsStore: this.modelsStore,
			authContext: this.authContext,
		});
		this.requests = new ModelRequests({
			getProvider: (id) => this.getProvider(id),
			getAuth: (model, overrides) => this.getAuth(model, overrides),
		});
	}

	setProvider(provider: Provider): void {
		this.refresher.supersede(provider.id);
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.refresher.supersede(id);
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.refresher.supersedeAll(this.providers.keys());
		this.providers.clear();
	}

	getProviders(): readonly Provider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): Provider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly Model<Api>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: Model<Api>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		return models;
	}

	getAllModels(provider?: string): readonly AnyModel[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getAllModels?.() ?? entry.getModels();
			} catch {
				return [];
			}
		}

		const models: AnyModel[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...(entry.getAllModels?.() ?? entry.getModels()));
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		return models;
	}

	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][] {
		return this.getAllModels(provider).filter((model): model is ModelTypeMap[TType] => isModelType(model, type));
	}

	getModel(provider: string, id: string): Model<Api> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	getModelOfType<TType extends ModelType>(type: TType, provider: string, id: string): ModelTypeMap[TType] | undefined {
		return this.getModelsOfType(type, provider).find((model) => model.id === id);
	}

	refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
		return this.refresher.refresh(options);
	}

	private async checkedProvider(provider: Provider, credentials: CredentialStore, signal: AbortSignal) {
		const credential = await readCredential(credentials, provider.id, signal);
		const auth = await checkProviderAuth(credentials, this.authContext, provider, credential, signal);
		return { provider, credential, auth };
	}

	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		const signal = operationSignal(options?.signal);
		const check = (async () => {
			signal.throwIfAborted();
			const provider = this.providers.get(providerId);
			if (!provider) return undefined;
			return (await this.checkedProvider(provider, this.credentials, signal)).auth;
		})();
		return raceWithAbortSignal(check, signal);
	}

	private async getAuthenticatedProviders(providerId: string | undefined, signal: AbortSignal) {
		signal.throwIfAborted();
		const providers = providerId
			? [this.providers.get(providerId)].filter((entry) => entry !== undefined)
			: this.getProviders();
		const checks = await Promise.all(
			providers.map((provider) => this.checkedProvider(provider, this.credentials, signal)),
		);
		return checks.filter((entry) => entry.auth !== undefined);
	}

	getAvailableFromStore(
		providerId: string,
		credentials: CredentialStore,
		options?: AuthOperationOptions,
	): Promise<{ authType: AuthType; models: readonly Model<Api>[] } | undefined> {
		const signal = operationSignal(options?.signal);
		const available = (async () => {
			signal.throwIfAborted();
			const provider = this.providers.get(providerId);
			if (!provider) return undefined;
			const { credential, auth } = await this.checkedProvider(provider, credentials, signal);
			return auth && { authType: auth.type, models: availableChatModels(provider, credential) };
		})();
		return raceWithAbortSignal(available, signal);
	}

	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		const signal = operationSignal(options?.signal);
		const available = this.getAuthenticatedProviders(providerId, signal).then((providers) =>
			providers.flatMap(({ provider, credential }) => availableChatModels(provider, credential)),
		);
		return raceWithAbortSignal(available, signal);
	}

	async getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return (await this.getAllAvailable(providerId, options)).filter((model): model is ModelTypeMap[TType] =>
			isModelType(model, type),
		);
	}

	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		const signal = operationSignal(options?.signal);
		const available = (async () => {
			const providers = await this.getAuthenticatedProviders(providerId, signal);
			return providers.flatMap(({ provider, credential }) => {
				const models = provider.getAllModels?.() ?? provider.getModels();
				if (provider.filterAllModels) return provider.filterAllModels(models, credential);
				if (!provider.filterModels) return models;
				const availableChatIds = new Set(
					provider.filterModels(provider.getModels(), credential).map((model) => model.id),
				);
				return models.filter((model) => !isModelType(model, "chat") || availableChatIds.has(model.id));
			});
		})();
		return raceWithAbortSignal(available, signal);
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | AnyModel,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const signal = operationSignal(overrides?.signal);
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		const result = await resolveProviderAuth(provider, this.credentials, this.authContext, { ...overrides, signal });
		if (!result || typeof providerOrModel === "string" || !providerOrModel.headers) return result;
		return {
			...result,
			auth: {
				...result.auth,
				headers: mergeHeaders(result.auth.headers, providerOrModel.headers),
			},
		};
	}

	login(providerId: string, type: AuthType, interaction: AuthInteraction, options?: LoginOptions): Promise<Credential> {
		return loginProvider(this.providers, this.credentials, providerId, type, interaction, options);
	}

	async logout(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return logoutProvider(this.providers.get(providerId), this.credentials, providerId, options);
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return this.requests.stream(model, context, options);
	}

	async complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.stream(model, context, options).result();
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		return this.requests.streamSimple(model, context, options);
	}

	async completeSimple(
		model: Model<Api>,
		context: Context,
		options?: ModelsSimpleStreamOptions,
	): Promise<AssistantMessage> {
		return this.streamSimple(model, context, options).result();
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return this.requests.streamDeferred(model, handle, options);
	}

	async fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.streamDeferred(model, handle, options).result();
	}

	cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredCancelOptions): Promise<void> {
		return this.requests.cancelDeferred(model, handle, options);
	}

	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		return this.requests.generateImages(model, context, options);
	}

	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		return this.requests.classify(model, context, options);
	}
}
