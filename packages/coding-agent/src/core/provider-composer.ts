import {
	type AnyModel,
	type Api,
	type AssistantMessageEventStream,
	type Credential,
	isModelType,
	lazyStream,
	type Model,
	type OAuthCredentials,
	type Provider,
	type ProviderHeaders,
	type StreamOptions,
	type TranscriptContext,
} from "@octocodeai/octocode-ai";
import { getApiProvider } from "@octocodeai/octocode-ai/compat";
import { classifierErrorResult, imageErrorResult } from "@octocodeai/octocode-ai/utils/model-operations";
import type { ModelConfig, ModelsJsonProvider } from "./model-config.ts";
import { composeApiKeyAuth, composeOAuthAuth, configuredApiKey, configuredHeaders } from "./provider-composer/auth.ts";
import {
	applyExtension,
	applyModelOverride,
	applyModelsJson,
	getAllProviderModels,
} from "./provider-composer/models.ts";
import type { KnownModelLookup } from "./provider-composer/known-models.ts";
import type { AuthStatus, ProviderConfigInput } from "./provider-composer/types.ts";
import {
	getConfigValueEnvVarNames,
	isCommandConfigValue,
	isConfigValueConfigured,
	resolveHeadersOrThrow,
} from "./config-value.ts";

export type { AuthStatus, ProviderConfigInput } from "./provider-composer/types.ts";

function rawModelHeaders(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): Record<string, string> | undefined {
	// models.json definitions and overrides are chat-only. Extension definitions
	// are matched by operation and id so colliding models cannot share headers.
	const chatDefinition = isModelType(model, "chat")
		? config?.models?.find((entry) => entry.id === model.id)
		: undefined;
	const extensionModel = extension?.models?.find(
		(entry) => (entry.type ?? "chat") === (model.type ?? "chat") && entry.id === model.id,
	);
	const headers = {
		...(isModelType(model, "chat") ? config?.modelOverrides?.[model.id]?.headers : undefined),
		...chatDefinition?.headers,
		...extensionModel?.headers,
	};
	return Object.keys(headers).length > 0 ? headers : undefined;
}

export function validateExtensionProvider(
	providerId: string,
	base: Provider | undefined,
	modelsConfig: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput,
): void {
	if (extension.streamSimple && !extension.api) {
		throw new Error(`Provider ${providerId}: "api" is required when registering streamSimple.`);
	}
	applyExtension(providerId, applyModelsJson(providerId, getAllProviderModels(base), modelsConfig), extension);
}

/** Compose built-in, models.json, and extension layers without reading credentials. */
export function composeModelProvider(
	providerId: string,
	base: Provider | undefined,
	modelConfig: ModelConfig,
	extension: ProviderConfigInput | undefined,
	known?: KnownModelLookup,
): Provider {
	const config = modelConfig.getProvider(providerId);
	let extensionOAuthCredential: OAuthCredentials | undefined;
	let refreshedExtensionModels: ProviderConfigInput["models"];
	const currentExtension = (): ProviderConfigInput | undefined =>
		extension && refreshedExtensionModels ? { ...extension, models: refreshedExtensionModels } : extension;
	// models.json modelOverrides are the topmost user-config layer: they apply once,
	// after custom-model upserts, extension model replacement, and legacy OAuth projection.
	const getAllModels = (): AnyModel[] => {
		let models = applyExtension(
			providerId,
			applyModelsJson(providerId, getAllProviderModels(base), config, known),
			currentExtension(),
		);
		if (extensionOAuthCredential && extension?.oauth?.modifyModels) {
			// The extension hook is chat-only; other model types pass through untouched.
			models = [
				...extension.oauth.modifyModels(
					models.filter((model) => isModelType(model, "chat")),
					extensionOAuthCredential,
				),
				...models.filter((model) => !isModelType(model, "chat")),
			];
		}
		return models.map((model) => {
			const override = config?.modelOverrides?.[model.id];
			return override && isModelType(model, "chat") ? applyModelOverride(model, override) : model;
		});
	};
	// Validate eagerly so registration/reload reports structural errors immediately.
	getAllModels();
	const apiKey = composeApiKeyAuth(providerId, base, config, extension);
	const oauth = composeOAuthAuth(providerId, base, config, extension);
	if (!apiKey && !oauth) throw new Error(`Provider ${providerId}: no authentication method configured.`);

	const supportsBaseApi = (model: Model<Api>) => base?.getModels().some((entry) => entry.api === model.api) ?? false;
	const streamWith = (
		model: Model<Api>,
		context: TranscriptContext,
		options: StreamOptions | undefined,
		simple: boolean,
	): AssistantMessageEventStream =>
		lazyStream(model, async () => {
			if (extension?.streamSimple && model.api === extension.api) {
				return extension.streamSimple(model, context, options);
			}
			if (base && supportsBaseApi(model)) {
				return simple ? base.streamSimple(model, context, options) : base.stream(model, context, options);
			}
			const api = getApiProvider(model.api);
			if (!api) throw new Error(`No API provider registered for api: ${model.api}`);
			return simple ? api.streamSimple(model, context, options) : api.stream(model, context, options);
		});

	const provider: Provider = {
		id: providerId,
		name: extension?.name ?? config?.name ?? base?.name ?? extension?.oauth?.name ?? providerId,
		baseUrl: extension?.baseUrl ?? config?.baseUrl ?? base?.baseUrl,
		headers: base?.headers,
		auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) },
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		getAllModels,
		refreshModels:
			base?.refreshModels || extension?.refreshModels || extension?.oauth?.modifyModels
				? async (context) => {
						await base?.refreshModels?.(context);
						let refreshed: NonNullable<ProviderConfigInput["models"]> | undefined;
						if (extension?.refreshModels) refreshed = await extension.refreshModels(context);
						if (context.signal.aborted) return;
						const oauthCredential = context.credential?.type === "oauth" ? context.credential : undefined;
						await context.publish({
							update: () => {
								if (refreshed) {
									// Validate before publishing the new synchronous list.
									applyExtension(providerId, applyModelsJson(providerId, getAllProviderModels(base), config, known), {
										...extension,
										models: refreshed,
									});
									refreshedExtensionModels = refreshed;
								}
								extensionOAuthCredential = oauthCredential;
							},
						});
					}
				: undefined,
		filterModels: base?.filterModels
			? (models, credential: Credential | undefined) => base.filterModels!(models, credential)
			: undefined,
		filterAllModels: base?.filterAllModels
			? (models, credential: Credential | undefined) => base.filterAllModels!(models, credential)
			: undefined,
		stream: (model, context, options) => streamWith(model, context, options, false),
		streamSimple: (model, context, options) => streamWith(model, context, options, true),
	};

	const fetchDeferred = base?.fetchDeferred;
	if (fetchDeferred) {
		provider.fetchDeferred = (model, handle, options) => fetchDeferred(model, handle, options);
	}
	const cancelDeferred = base?.cancelDeferred;
	if (cancelDeferred) {
		provider.cancelDeferred = (model, handle, options) => cancelDeferred(model, handle, options);
	}
	const extensionImages = extension?.images;
	const generateImages = base?.generateImages;
	if (generateImages || Object.keys(extensionImages ?? {}).length > 0) {
		provider.generateImages = (model, context, options) => {
			const implementation = extensionImages?.[model.api];
			if (implementation) return implementation.generateImages(model, context, options);
			if (generateImages) return generateImages(model, context, options);
			return Promise.resolve(
				imageErrorResult(model, new Error(`Provider ${providerId} has no image implementation for "${model.api}"`)),
			);
		};
	}
	const extensionClassifiers = extension?.classifiers;
	const classify = base?.classify;
	if (classify || Object.keys(extensionClassifiers ?? {}).length > 0) {
		provider.classify = (model, context, options) => {
			const implementation = extensionClassifiers?.[model.api];
			if (implementation) return implementation.classify(model, context, options);
			if (classify) return classify(model, context, options);
			return Promise.resolve(
				classifierErrorResult(
					model,
					new Error(`Provider ${providerId} has no classifier implementation for "${model.api}"`),
				),
			);
		};
	}

	return provider;
}

export function resolveConfiguredModelHeaders(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	return resolveHeadersOrThrow(rawModelHeaders(model, config, extension), `model "${model.provider}/${model.id}"`, env);
}

export interface CompatibilityRequestConfig {
	headers?: ProviderHeaders;
	authHeader: boolean;
}

export function resolveCompatibilityRequestConfig(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): CompatibilityRequestConfig {
	const configured = resolveHeadersOrThrow(
		{ ...configuredHeaders(config, extension), ...rawModelHeaders(model, config, extension) },
		`model "${model.provider}/${model.id}"`,
	);
	return {
		headers: model.headers || configured ? { ...model.headers, ...configured } : undefined,
		authHeader: extension?.authHeader ?? config?.authHeader ?? false,
	};
}

export function configuredRequestAuthStatus(
	config: ModelsJsonProvider | undefined,
	extension: ProviderConfigInput | undefined,
): AuthStatus | undefined {
	const value = configuredApiKey(config, extension);
	if (value === undefined) return undefined;
	if (isCommandConfigValue(value)) return { configured: true, source: "models_json_command" };
	const names = getConfigValueEnvVarNames(value);
	if (names.length > 0) {
		return isConfigValueConfigured(value)
			? { configured: true, source: "environment", label: names.join(", ") }
			: { configured: false };
	}
	return { configured: true, source: extension?.apiKey !== undefined ? "fallback" : "models_json_key" };
}
