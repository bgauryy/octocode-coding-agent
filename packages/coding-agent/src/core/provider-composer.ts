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
import { withCacheCapabilities } from "@octocodeai/octocode-ai/utils/cache-capabilities";
import { classifierErrorResult, imageErrorResult } from "@octocodeai/octocode-ai/utils/model-operations";
import type { ModelConfig, ModelsJsonProvider } from "./model-config.ts";
import { composeApiKeyAuth, composeOAuthAuth, configuredApiKey, configuredHeaders } from "./provider-composer/auth.ts";
import { applyFeature, applyModelOverride, applyModelsJson, getAllProviderModels } from "./provider-composer/models.ts";
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
	feature: ProviderConfigInput | undefined,
): Record<string, string> | undefined {
	// models.json definitions and overrides are chat-only. Feature definitions
	// are matched by operation and id so colliding models cannot share headers.
	const chatDefinition = isModelType(model, "chat")
		? config?.models?.find((entry) => entry.id === model.id)
		: undefined;
	const featureModel = feature?.models?.find(
		(entry) => (entry.type ?? "chat") === (model.type ?? "chat") && entry.id === model.id,
	);
	const headers = {
		...(isModelType(model, "chat") ? config?.modelOverrides?.[model.id]?.headers : undefined),
		...chatDefinition?.headers,
		...featureModel?.headers,
	};
	return Object.keys(headers).length > 0 ? headers : undefined;
}

export function validateFeatureProvider(
	providerId: string,
	base: Provider | undefined,
	modelsConfig: ModelsJsonProvider | undefined,
	feature: ProviderConfigInput,
): void {
	if (feature.streamSimple && !feature.api) {
		throw new Error(`Provider ${providerId}: "api" is required when registering streamSimple.`);
	}
	applyFeature(providerId, applyModelsJson(providerId, getAllProviderModels(base), modelsConfig), feature);
}

/** Compose built-in, models.json, and feature layers without reading credentials. */
export function composeModelProvider(
	providerId: string,
	base: Provider | undefined,
	modelConfig: ModelConfig,
	feature: ProviderConfigInput | undefined,
	known?: KnownModelLookup,
): Provider {
	const config = modelConfig.getProvider(providerId);
	let featureOAuthCredential: OAuthCredentials | undefined;
	let refreshedFeatureModels: ProviderConfigInput["models"];
	const currentFeature = (): ProviderConfigInput | undefined =>
		feature && refreshedFeatureModels ? { ...feature, models: refreshedFeatureModels } : feature;
	// models.json modelOverrides are the topmost user-config layer: they apply once,
	// after custom-model upserts, feature model replacement, and legacy OAuth projection.
	const getAllModels = (): AnyModel[] => {
		let models = applyFeature(
			providerId,
			applyModelsJson(providerId, getAllProviderModels(base), config, known),
			currentFeature(),
		);
		if (featureOAuthCredential && feature?.oauth?.modifyModels) {
			// The feature hook is chat-only; other model types pass through untouched.
			models = [
				...feature.oauth.modifyModels(
					models.filter((model) => isModelType(model, "chat")),
					featureOAuthCredential,
				),
				...models.filter((model) => !isModelType(model, "chat")),
			];
		}
		return models.map((model) => {
			if (!isModelType(model, "chat")) return model;
			// Custom models never passed through the catalog's stamping: declare their cache compat here (explicit values win).
			const stamped = withCacheCapabilities(model);
			const override = config?.modelOverrides?.[model.id];
			return override ? applyModelOverride(stamped, override) : stamped;
		});
	};
	// Validate eagerly so registration/reload reports structural errors immediately.
	getAllModels();
	const apiKey = composeApiKeyAuth(providerId, base, config, feature);
	const oauth = composeOAuthAuth(providerId, base, config, feature);
	if (!apiKey && !oauth) throw new Error(`Provider ${providerId}: no authentication method configured.`);

	const supportsBaseApi = (model: Model<Api>) => base?.getModels().some((entry) => entry.api === model.api) ?? false;
	const streamWith = (
		model: Model<Api>,
		context: TranscriptContext,
		options: StreamOptions | undefined,
		simple: boolean,
	): AssistantMessageEventStream =>
		lazyStream(model, async () => {
			if (feature?.streamSimple && model.api === feature.api) {
				return feature.streamSimple(model, context, options);
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
		name: feature?.name ?? config?.name ?? base?.name ?? feature?.oauth?.name ?? providerId,
		baseUrl: feature?.baseUrl ?? config?.baseUrl ?? base?.baseUrl,
		headers: base?.headers,
		auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) },
		getModels: () => getAllModels().filter((model) => isModelType(model, "chat")),
		getAllModels,
		refreshModels:
			base?.refreshModels || feature?.refreshModels || feature?.oauth?.modifyModels
				? async (context) => {
						await base?.refreshModels?.(context);
						let refreshed: NonNullable<ProviderConfigInput["models"]> | undefined;
						if (feature?.refreshModels) refreshed = await feature.refreshModels(context);
						if (context.signal.aborted) return;
						const oauthCredential = context.credential?.type === "oauth" ? context.credential : undefined;
						await context.publish({
							update: () => {
								if (refreshed) {
									// Validate before publishing the new synchronous list.
									applyFeature(providerId, applyModelsJson(providerId, getAllProviderModels(base), config, known), {
										...feature,
										models: refreshed,
									});
									refreshedFeatureModels = refreshed;
								}
								featureOAuthCredential = oauthCredential;
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
	const featureImages = feature?.images;
	const generateImages = base?.generateImages;
	if (generateImages || Object.keys(featureImages ?? {}).length > 0) {
		provider.generateImages = (model, context, options) => {
			const implementation = featureImages?.[model.api];
			if (implementation) return implementation.generateImages(model, context, options);
			if (generateImages) return generateImages(model, context, options);
			return Promise.resolve(
				imageErrorResult(model, new Error(`Provider ${providerId} has no image implementation for "${model.api}"`)),
			);
		};
	}
	const featureClassifiers = feature?.classifiers;
	const classify = base?.classify;
	if (classify || Object.keys(featureClassifiers ?? {}).length > 0) {
		provider.classify = (model, context, options) => {
			const implementation = featureClassifiers?.[model.api];
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
	feature: ProviderConfigInput | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	return resolveHeadersOrThrow(rawModelHeaders(model, config, feature), `model "${model.provider}/${model.id}"`, env);
}

export interface CompatibilityRequestConfig {
	headers?: ProviderHeaders;
	authHeader: boolean;
}

export function resolveCompatibilityRequestConfig(
	model: AnyModel,
	config: ModelsJsonProvider | undefined,
	feature: ProviderConfigInput | undefined,
): CompatibilityRequestConfig {
	const configured = resolveHeadersOrThrow(
		{ ...configuredHeaders(config, feature), ...rawModelHeaders(model, config, feature) },
		`model "${model.provider}/${model.id}"`,
	);
	return {
		headers: model.headers || configured ? { ...model.headers, ...configured } : undefined,
		authHeader: feature?.authHeader ?? config?.authHeader ?? false,
	};
}

export function configuredRequestAuthStatus(
	config: ModelsJsonProvider | undefined,
	feature: ProviderConfigInput | undefined,
): AuthStatus | undefined {
	const value = configuredApiKey(config, feature);
	if (value === undefined) return undefined;
	if (isCommandConfigValue(value)) return { configured: true, source: "models_json_command" };
	const names = getConfigValueEnvVarNames(value);
	if (names.length > 0) {
		return isConfigValueConfigured(value)
			? { configured: true, source: "environment", label: names.join(", ") }
			: { configured: false };
	}
	return { configured: true, source: feature?.apiKey !== undefined ? "fallback" : "models_json_key" };
}
