import { type AnyModel, type Api, isModelType, type Model, type Provider } from "@octocodeai/octocode-ai";
import { withCacheEndpoint } from "@octocodeai/octocode-ai/utils/cache-capabilities";
import type { ModelsJsonModel, ModelsJsonModelOverride, ModelsJsonProvider } from "../model-config.ts";
import type { ProviderConfigInput, ProviderModelConfig } from "./types.ts";

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

function mergeInputLimits(
	base: Model<Api>["inputLimits"],
	override: ModelsJsonModelOverride["inputLimits"],
): Model<Api>["inputLimits"] {
	if (!override) return base;
	return {
		...base,
		...override,
		images: override.images
			? {
					...base?.images,
					...override.images,
					resize: override.images.resize
						? { ...base?.images?.resize, ...override.images.resize }
						: base?.images?.resize,
				}
			: base?.images,
	};
}

function mergeSamplingParamsByThinkingLevel(
	base: Model<Api>["samplingParamsByThinkingLevel"],
	override: Model<Api>["samplingParamsByThinkingLevel"],
): Model<Api>["samplingParamsByThinkingLevel"] {
	if (!override) return base;
	const merged = { ...base };
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		const params = override[level];
		if (params) merged[level] = { ...base?.[level], ...params };
	}
	return merged;
}

export function applyModelOverride(model: Model<Api>, override: ModelsJsonModelOverride): Model<Api> {
	return {
		...model,
		name: override.name ?? model.name,
		reasoning: override.reasoning ?? model.reasoning,
		thinkingLevelMap: override.thinkingLevelMap
			? { ...model.thinkingLevelMap, ...override.thinkingLevelMap }
			: model.thinkingLevelMap,
		input: override.input ?? model.input,
		inputLimits: mergeInputLimits(model.inputLimits, override.inputLimits),
		cost: override.cost
			? {
					input: override.cost.input ?? model.cost.input,
					output: override.cost.output ?? model.cost.output,
					cacheRead: override.cost.cacheRead ?? model.cost.cacheRead,
					cacheWrite: override.cost.cacheWrite ?? model.cost.cacheWrite,
					tiers: override.cost.tiers ?? model.cost.tiers,
				}
			: model.cost,
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

function modelFromJson(
	providerId: string,
	definition: ModelsJsonModel,
	providerConfig: ModelsJsonProvider,
	defaults: Model<Api> | undefined,
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
	return {
		id: definition.id,
		name: definition.name ?? definition.id,
		api: api,
		provider: providerId,
		baseUrl,
		reasoning: definition.reasoning ?? false,
		thinkingLevelMap: definition.thinkingLevelMap,
		input: definition.input ?? ["text"],
		inputLimits: definition.inputLimits,
		cost: definition.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		promptCache: definition.promptCache,
		contextWindow: definition.contextWindow ?? 128000,
		maxTokens: definition.maxTokens ?? 16384,
		samplingParams: definition.samplingParams,
		samplingParamsByThinkingLevel: definition.samplingParamsByThinkingLevel,
		headers: undefined,
		compat: mergeCompat(providerConfig.compat, definition.compat),
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

function findExtensionModelDefaults(
	models: readonly AnyModel[],
	definition: ProviderModelConfig,
): AnyModel | undefined {
	const type = definition.type ?? "chat";
	const candidates = models.filter((model) => isModelType(model, type));
	return (
		candidates.find((model) => model.id === definition.id) ??
		(definition.api ? candidates.find((model) => model.api === definition.api) : undefined) ??
		(type === "chat" ? candidates.find((model) => model.api === "openai-completions") : undefined) ??
		candidates[0]
	);
}

function extensionModelFromDefinition(
	providerId: string,
	models: readonly AnyModel[],
	config: ProviderConfigInput,
	definition: ProviderModelConfig,
): AnyModel {
	const type = definition.type ?? "chat";
	const defaults = findExtensionModelDefaults(models, definition);
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

export function applyModelsJson(
	providerId: string,
	baseModels: readonly AnyModel[],
	config: ModelsJsonProvider | undefined,
): AnyModel[] {
	if (!config) return [...baseModels];
	const hasOverrides = config.modelOverrides && Object.keys(config.modelOverrides).length > 0;
	if (
		!config.models?.length &&
		!config.baseUrl &&
		!config.headers &&
		!config.compat &&
		!hasOverrides &&
		!config.apiKey &&
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
		return { ...endpointModel, compat: mergeCompat(endpointModel.compat, config.compat) };
	});
	for (const definition of config.models ?? []) {
		const existingIndex = models.findIndex((model) => isModelType(model, "chat") && model.id === definition.id);
		const defaults = findModelDefaults(models, definition.id, definition.api ?? config.api);
		const model = modelFromJson(providerId, definition, config, defaults);
		if (existingIndex >= 0) models[existingIndex] = model;
		else models.push(model);
	}
	return models;
}

export function applyExtension(
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
	return config.models.map((definition) => extensionModelFromDefinition(providerId, models, config, definition));
}
