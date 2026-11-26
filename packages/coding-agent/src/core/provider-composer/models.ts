import { type AnyModel, type Api, isModelType, type Model, type Provider } from "@octocodeai/octocode-ai";
import { withCacheEndpoint } from "@octocodeai/octocode-ai/utils/cache-capabilities";
import { inferThinkingLevelMap } from "@octocodeai/octocode-ai/utils/thinking-level-rules";
import type {
	ModelsJsonModel,
	ModelsJsonModelOverride,
	ModelsJsonProvider,
	ModelsJsonProviderDefaults,
} from "../model-config.ts";
import { mergeCost, mergeInputLimits, mergeSamplingParamsByThinkingLevel } from "./override-merge.ts";
import type { KnownModelLookup } from "./known-models.ts";
import type { ProviderConfigInput, ProviderModelConfig } from "./types.ts";

type DefaultedField = "cost" | "input" | "contextWindow" | "maxTokens";

const ASSUMED_DEFAULTS: Record<DefaultedField, string> = {
	cost: "cost 0 (usage shows as free)",
	input: 'input ["text"]',
	contextWindow: "contextWindow 128000 tokens",
	maxTokens: "maxTokens 16384",
};

/** Custom models whose fields neither models.json nor a built-in twin set, by `provider/id`: what composition assumed. */
const defaultedFields = new Map<string, DefaultedField[]>();

/**
 * One sentence naming every field a custom model got by default, and how to set them, or undefined when it has none.
 * A `modelOverrides` entry that sets a field removes it from the list.
 */
export function defaultedModelNotice(provider: string, id: string): string | undefined {
	const fields = defaultedFields.get(`${provider}/${id}`);
	if (!fields?.length) return undefined;
	return `${provider}/${id} sets no ${fields.join(", ")} in models.json and has no built-in twin to take them from: assuming ${fields.map((field) => ASSUMED_DEFAULTS[field]).join(", ")}. Set them on the model's entry${fields.includes("contextWindow") ? ", above all contextWindow, so compaction runs before the real window fills" : ""}.`;
}

export function getAllProviderModels(provider: Provider | undefined): readonly AnyModel[] {
	return provider ? (provider.getAllModels?.() ?? provider.getModels()) : [];
}

function mergeCompat(
	base: Model<Api>["compat"],
	override: Model<Api>["compat"] | ModelsJsonModelOverride["compat"],
): Model<Api>["compat"] {
	if (!override) return base;
	const merged = { ...base, ...override } as NonNullable<Model<Api>["compat"]>;
	const baseNested = base as Record<string, unknown> | undefined;
	const overrideNested = override as Record<string, unknown>;
	const mergedNested = merged as Record<string, unknown>;
	for (const key of ["openRouterRouting", "vercelGatewayRouting", "chatTemplateKwargs", "chatTemplateArgs"] as const) {
		const baseValue = baseNested?.[key];
		const overrideValue = overrideNested[key];
		if (
			(typeof baseValue === "object" && baseValue !== null) ||
			(typeof overrideValue === "object" && overrideValue !== null)
		) {
			mergedNested[key] = { ...(baseValue as object | undefined), ...(overrideValue as object | undefined) };
		}
	}
	return merged;
}

export function applyModelOverride(model: Model<Api>, override: ModelsJsonModelOverride): Model<Api> {
	const key = `${model.provider}/${model.id}`;
	const assumed = defaultedFields.get(key);
	if (assumed) {
		const set = (field: DefaultedField) => override[field] !== undefined;
		const left = assumed.filter((field) => !set(field));
		if (left.length > 0) defaultedFields.set(key, left);
		else defaultedFields.delete(key);
	}
	return {
		...model,
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap
			? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
			: model.thinkingLevelMap,
		input: override.input ?? model.input,
		inputLimits: mergeInputLimits(model.inputLimits, override.inputLimits),
		cost: mergeCost(model.cost, override.cost),
		promptCache: override.promptCache ? { ...model.promptCache, ...override.promptCache } : model.promptCache,
		contextWindow: override.contextWindow ?? model.contextWindow,
		maxTokens: override.maxTokens ?? model.maxTokens,
		samplingParams: override.samplingParams
			? { ...model.samplingParams, ...override.samplingParams }
			: model.samplingParams,
		samplingParamsByThinkingLevel: mergeSamplingParamsByThinkingLevel(
			model.samplingParamsByThinkingLevel,
			override.samplingParamsByThinkingLevel,
		),
		compat: mergeCompat(model.compat, override.compat),
	};
}

/** A models.json model entry with the provider's defaults beneath it: each field the entry sets wins. */
function withProviderDefaults(
	definition: ModelsJsonModel,
	defaults: ModelsJsonProviderDefaults | undefined,
): ModelsJsonModel {
	if (!defaults) return definition;
	return {
		...definition,
		reasoning: definition.reasoning ?? defaults.reasoning,
		thinkingLevelMap:
			defaults.thinkingLevelMap || definition.thinkingLevelMap
				? { ...defaults.thinkingLevelMap, ...definition.thinkingLevelMap }
				: undefined,
		input: definition.input ?? defaults.input,
		inputLimits: mergeInputLimits(defaults.inputLimits, definition.inputLimits),
		cost: definition.cost ?? defaults.cost,
		promptCache:
			defaults.promptCache || definition.promptCache
				? { ...defaults.promptCache, ...definition.promptCache }
				: undefined,
		contextWindow: definition.contextWindow ?? defaults.contextWindow,
		maxTokens: definition.maxTokens ?? defaults.maxTokens,
		samplingParams:
			defaults.samplingParams || definition.samplingParams
				? { ...defaults.samplingParams, ...definition.samplingParams }
				: undefined,
		samplingParamsByThinkingLevel: mergeSamplingParamsByThinkingLevel(
			defaults.samplingParamsByThinkingLevel,
			definition.samplingParamsByThinkingLevel,
		),
		compat: mergeCompat(defaults.compat, definition.compat),
	};
}

/**
 * The model with its provider's defaults and then its own `modelOverrides` entry on top. A model models.json defines
 * took the defaults when it was built (`withProviderDefaults`), where its own fields beat them, so only the override
 * applies again.
 */
export function applyModelDefaultsAndOverride(model: Model<Api>, config: ModelsJsonProvider | undefined): Model<Api> {
	const defined = config?.models?.some((entry) => entry.id === model.id) ?? false;
	const withDefaults = config?.defaults && !defined ? applyModelOverride(model, config.defaults) : model;
	const override = config?.modelOverrides?.[model.id];
	return override ? applyModelOverride(withDefaults, override) : withDefaults;
}

function modelFromJson(
	providerId: string,
	definition: ModelsJsonModel,
	providerConfig: ModelsJsonProvider,
	defaults: Model<Api> | undefined,
	knownBase: Model<Api> | undefined,
): Model<Api> {
	const api = definition.api ?? providerConfig.api ?? defaults?.api;
	if (!api) {
		throw new Error(
			`Provider ${providerId}, model ${definition.id}: no "api" specified. Set at provider or model level.`,
		);
	}
	const baseUrl = definition.baseUrl ?? providerConfig.baseUrl ?? defaults?.baseUrl;
	if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	if (definition.contextWindow !== undefined && definition.contextWindow <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid contextWindow`);
	}
	if (definition.maxTokens !== undefined && definition.maxTokens <= 0) {
		throw new Error(`Provider ${providerId}, model ${definition.id}: invalid maxTokens`);
	}
	// The same model's metadata seen through this entry's host: a direct provider's endpoint-bound claims (long cache
	// retention, explicit cache mode, cache lifetimes) do not carry to another host. Only a model of the same API qualifies.
	const known = knownBase && knownBase.api === api ? withCacheEndpoint(knownBase, baseUrl) : undefined;
	const reasoning = definition.reasoning ?? known?.reasoning ?? false;
	const compat = mergeCompat(mergeCompat(known?.compat, providerConfig.compat), definition.compat);
	// A model with no effort map of its own or a known twin's gets the one the built-in catalog's rules give its id,
	// unless a known twin exists: on its own API the catalog already applied the rules, and on another API the
	// effort vocabulary is API-specific and must not cross.
	const thinkingLevelMap =
		definition.thinkingLevelMap ??
		known?.thinkingLevelMap ??
		(knownBase
			? undefined
			: inferThinkingLevelMap({
					id: definition.id,
					provider: providerId,
					baseUrl,
					api,
					reasoning,
					compat,
					profile: providerConfig.profile,
				}));
	const defaulted: DefaultedField[] = [];
	if (!definition.cost && !known?.cost) defaulted.push("cost");
	if (!definition.input && !known?.input) defaulted.push("input");
	if (definition.contextWindow === undefined && known?.contextWindow === undefined) defaulted.push("contextWindow");
	if (definition.maxTokens === undefined && known?.maxTokens === undefined) defaulted.push("maxTokens");
	if (defaulted.length > 0) defaultedFields.set(`${providerId}/${definition.id}`, defaulted);
	else defaultedFields.delete(`${providerId}/${definition.id}`);
	return {
		id: definition.id,
		name: definition.name ?? known?.name ?? definition.id,
		api: api,
		provider: providerId,
		baseUrl,
		reasoning,
		thinkingLevelMap,
		input: definition.input ?? known?.input ?? ["text"],
		inputLimits: mergeInputLimits(known?.inputLimits, definition.inputLimits),
		cost: definition.cost ?? known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		promptCache: definition.promptCache ?? known?.promptCache,
		contextWindow: definition.contextWindow ?? known?.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? known?.maxTokens ?? 16384,
		samplingParams: definition.samplingParams ?? known?.samplingParams,
		samplingParamsByThinkingLevel: definition.samplingParamsByThinkingLevel ?? known?.samplingParamsByThinkingLevel,
		headers: undefined,
		...(providerConfig.profile ? { profile: providerConfig.profile } : {}),
		compat,
	};
}

function findModelDefaults(models: readonly AnyModel[], modelId: string, api?: Api): Model<Api> | undefined {
	const chatModels = models.filter((model) => isModelType(model, "chat"));
	return (
		chatModels.find((model) => model.id === modelId) ??
		(api ? chatModels.find((model) => model.api === api) : undefined) ??
		chatModels.find((model) => model.api === "openai-completions") ??
		chatModels[0]
	);
}

function findFeatureModelDefaults(models: readonly AnyModel[], definition: ProviderModelConfig): AnyModel | undefined {
	const type = definition.type ?? "chat";
	const candidates = models.filter((model) => isModelType(model, type));
	return (
		candidates.find((model) => model.id === definition.id) ??
		(definition.api ? candidates.find((model) => model.api === definition.api) : undefined) ??
		(type === "chat" ? candidates.find((model) => model.api === "openai-completions") : undefined) ??
		candidates[0]
	);
}

function featureModelFromDefinition(
	providerId: string,
	models: readonly AnyModel[],
	config: ProviderConfigInput,
	definition: ProviderModelConfig,
): AnyModel {
	const type = definition.type ?? "chat";
	const defaults = findFeatureModelDefaults(models, definition);
	const api = definition.api ?? (type === "chat" ? config.api : undefined) ?? defaults?.api;
	if (!api) {
		throw new Error(
			`Provider ${providerId}, model ${definition.id}: no "api" specified. Set it at model level${type === "chat" ? " or provider level" : ""}.`,
		);
	}
	const baseUrl = definition.baseUrl ?? config.baseUrl ?? defaults?.baseUrl;
	if (!baseUrl) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
	if (definition.type === "image") {
		return { ...definition, api: api, provider: providerId, baseUrl, headers: undefined };
	}
	if (definition.type === "classifier") {
		return { ...definition, api: api, provider: providerId, baseUrl, headers: undefined };
	}
	return { ...definition, api: api, provider: providerId, baseUrl, headers: undefined };
}

/**
 * Layer a provider's `models.json` entry over its models. An entry whose id names a known model (the provider's own,
 * else the built-in model of the vendor its API belongs to, through `known`) inherits that model's metadata.
 */
export function applyModelsJson(
	providerId: string,
	baseModels: readonly AnyModel[],
	config: ModelsJsonProvider | undefined,
	known?: KnownModelLookup,
): AnyModel[] {
	if (!config) return [...baseModels];
	const hasOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
	if (
		!config.models?.length &&
		!config.baseUrl &&
		!config.headers &&
		!config.compat &&
		!config.defaults &&
		!config.profile &&
		config.requestsPerMinute === undefined &&
		config.tokensPerMinute === undefined &&
		!hasOverrides &&
		!config.apiKey &&
		!config.auth &&
		!config.env &&
		config.cacheRetention === undefined &&
		config.instructionCacheRetention === undefined &&
		config.authHeader === undefined
	) {
		throw new Error(
			`Provider ${providerId}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".`,
		);
	}

	const models: AnyModel[] = baseModels.map((model) => {
		const baseUrl = config.baseUrl ?? model.baseUrl;
		if (!isModelType(model, "chat")) return { ...model, baseUrl };
		const endpointModel = withCacheEndpoint(model, baseUrl);
		return {
			...endpointModel,
			...(config.profile ? { profile: config.profile } : {}),
			compat: mergeCompat(endpointModel.compat, config.compat),
		};
	});
	for (const definition of config.models ?? []) {
		const existingIndex = models.findIndex((model) => isModelType(model, "chat") && model.id === definition.id);
		const defaults = findModelDefaults(models, definition.id, definition.api ?? config.api);
		const api = definition.api ?? config.api ?? defaults?.api;
		const existing = existingIndex >= 0 ? (models[existingIndex] as Model<Api>) : undefined;
		const knownBase =
			existing?.api === api
				? existing
				: api
					? known?.(api, definition.id, definition.baseUrl ?? config.baseUrl ?? defaults?.baseUrl)
					: undefined;
		const model = modelFromJson(
			providerId,
			withProviderDefaults(definition, config.defaults),
			config,
			defaults,
			knownBase,
		);
		if (existingIndex >= 0) models[existingIndex] = model;
		else models.push(model);
	}
	return models;
}

export function applyFeature(
	providerId: string,
	models: readonly AnyModel[],
	config: ProviderConfigInput | undefined,
): AnyModel[] {
	if (!config) return [...models];
	if (!config.models) {
		return config.baseUrl
			? models.map((model) =>
					isModelType(model, "chat")
						? withCacheEndpoint(model, config.baseUrl!)
						: { ...model, baseUrl: config.baseUrl! },
				)
			: [...models];
	}
	return config.models.map((definition) => featureModelFromDefinition(providerId, models, config, definition));
}
