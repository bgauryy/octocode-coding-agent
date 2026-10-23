import type { Model, OpenAICompletionsCompat } from "../../src/types.ts";
import { assertExactModelIds } from "../model-data.ts";
import { getEffortThinkingLevelMap } from "../models-dev-reasoning-options.ts";
import {
	KIMI_K3_COST,
	KIMI_K3_OPENAI_COMPAT,
	KIMI_OPENAI_COMPAT,
	QWEN_TOKEN_PLAN_EXCLUDED_MODEL_IDS,
	QWEN_TOKEN_PLAN_FALLBACK_THINKING_LEVEL_MAP,
	QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS,
	QWEN_TOKEN_PLAN_REASONING_EFFORT_FALLBACK_MODEL_IDS,
} from "./constants.ts";
import { generatorOptions } from "./options.ts";
import { getModelsDevCost } from "./pricing.ts";
import { createKimiCodingModels } from "./processors.ts";
import { recordModelsDevReasoningOptions } from "./thinking-levels.ts";
import type { ModelsDevCatalog, ModelsDevModel } from "./types.ts";

/** models.dev subscription and token plans: MiniMax, Kimi For Coding, Moonshot AI, Xiaomi MiMo and Qwen Token Plan. */
export function addModelsDevPlanModels(data: ModelsDevCatalog, models: Model<any>[]): void {
	// Process MiniMax models
	const minimaxVariants = [
		{ key: "minimax", provider: "minimax", baseUrl: "https://api.minimax.io/anthropic" },
		{ key: "minimax-cn", provider: "minimax-cn", baseUrl: "https://api.minimaxi.com/anthropic" },
	] as const;
	// MiniMax asked to hide older models from its direct providers (#2596).
	const minimaxHiddenIds = new Set(["MiniMax-M2", "MiniMax-M2.1", "MiniMax-M2.5", "MiniMax-M2.5-highspeed"]);

	for (const { key, provider, baseUrl } of minimaxVariants) {
		if (data[key]?.models) {
			for (const [modelId, model] of Object.entries(data[key].models)) {
				const m = model;
				if (m.tool_call !== true || minimaxHiddenIds.has(modelId)) continue;
				// Models with effort levels (e.g. MiniMax-M3.1-Flash) take adaptive thinking with
				// output_config.effort and reject thinking.type="disabled" (no "none" effort, so off is null).
				const thinkingLevelMap = getEffortThinkingLevelMap(m.reasoning_options ?? []);

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider,
					// MiniMax's Anthropic-compatible API - SDK appends /v1/messages
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(thinkingLevelMap ? { thinkingLevelMap, compat: { forceAdaptiveThinking: true } } : {}),
				});
			}
		}
	}

	// Process Kimi For Coding models
	if (data["kimi-code-plan-global"]?.models) {
		models.push(...createKimiCodingModels(data["kimi-code-plan-global"].models));
	}

	// Process Moonshot AI models
	const moonshotVariants = [
		{ key: "moonshotai", provider: "moonshotai", baseUrl: "https://api.moonshot.ai/v1" },
		{ key: "moonshotai-cn", provider: "moonshotai-cn", baseUrl: "https://api.moonshot.cn/v1" },
	] as const;
	const getMoonshotProviderModels = (key: "moonshotai" | "moonshotai-cn"): Record<string, ModelsDevModel> => {
		const providerModels = data[key]?.models;
		return providerModels ? { ...providerModels } : {};
	};
	const moonshotModels = {
		moonshotai: getMoonshotProviderModels("moonshotai"),
		"moonshotai-cn": getMoonshotProviderModels("moonshotai-cn"),
	};

	for (const { key, provider, baseUrl } of moonshotVariants) {
		for (const [modelId, m] of Object.entries(moonshotModels[key])) {
			if (m.tool_call !== true) continue;

			const isKimiK3 = modelId === "kimi-k3";
			const compat = { ...(isKimiK3 ? KIMI_K3_OPENAI_COMPAT : KIMI_OPENAI_COMPAT) };
			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider,
				baseUrl,
				reasoning: isKimiK3 || m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				// Moonshot does not bill cache writes; models.dev lists the input rate as cache_write for Kimi K3.
				cost: isKimiK3
					? { ...KIMI_K3_COST }
					: {
							input: m.cost?.input || 0,
							output: m.cost?.output || 0,
							cacheRead: m.cost?.cache_read || 0,
							cacheWrite: m.cost?.cache_write || 0,
						},
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
				compat,
			});
			recordModelsDevReasoningOptions(provider, modelId, m);
		}
	}

	// Process Xiaomi MiMo models
	// Built-in `xiaomi` targets the API billing endpoint (single stable URL,
	// keys from platform.xiaomimimo.com). The three `xiaomi-token-plan-*`
	// providers cover prepaid Token Plan endpoints in cn / ams / sgp.
	// MiMo Chat Completions only documents thinking.type enabled/disabled and
	// rejects some reasoning_effort values (e.g. "minimal"). Xiaomi documents
	// all effort levels as identical, so expose only off and high.
	const xiaomiCompat: OpenAICompletionsCompat = {
		supportsReasoningEffort: false,
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	};
	const xiaomiThinkingLevelMap = {
		off: "off",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	} as const;
	const xiaomiVariants = [
		{ source: "xiaomi", provider: "xiaomi", baseUrl: "https://api.xiaomimimo.com/v1" },
		{
			source: "xiaomi-token-plan-cn",
			provider: "xiaomi-token-plan-cn",
			baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
		},
		{
			source: "xiaomi-token-plan-ams",
			provider: "xiaomi-token-plan-ams",
			baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
		},
		{
			source: "xiaomi-token-plan-sgp",
			provider: "xiaomi-token-plan-sgp",
			baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
		},
	] as const;

	for (const { source, provider, baseUrl } of xiaomiVariants) {
		const providerModels = data[source]?.models;
		if (!providerModels) continue;

		for (const [modelId, model] of Object.entries(providerModels)) {
			const m = model;
			if (m.tool_call !== true) continue;
			if (m.status === "deprecated") continue;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider,
				baseUrl,
				compat: xiaomiCompat,
				reasoning: m.reasoning === true,
				...(m.reasoning === true ? { thinkingLevelMap: xiaomiThinkingLevelMap } : {}),
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
		}
	}

	// Process Alibaba Cloud Model Studio Token Plan models. International and
	// China use separate endpoints and API keys (sk-sp- prefix). The Individual
	// provider reuses the international source and endpoint with a narrower catalog.
	// models.dev keys are "alibaba-token-plan[-cn]"; pi exposes them as
	// "qwen-token-plan[-cn]" plus the Individual catalog view.
	const qwenTokenPlanCompat: OpenAICompletionsCompat = {
		thinkingFormat: "qwen",
		supportsDeveloperRole: false,
		supportsStore: false,
		supportsReasoningEffort: true,
	};
	const qwenTokenPlanVariants = [
		{
			source: "alibaba-token-plan",
			provider: "qwen-token-plan",
			baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
			modelIds: undefined,
		},
		{
			source: "alibaba-token-plan",
			provider: "qwen-token-plan-individual",
			baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
			modelIds: QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS,
		},
		{
			source: "alibaba-token-plan-cn",
			provider: "qwen-token-plan-cn",
			baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
			modelIds: undefined,
		},
	] as const;

	for (const { source, provider, baseUrl, modelIds } of qwenTokenPlanVariants) {
		const providerModels = data[source]?.models;
		const emittedModelIds = modelIds ? new Set<string>() : undefined;

		for (const [modelId, model] of Object.entries(providerModels ?? {})) {
			const m = model;
			if (m.tool_call !== true) continue;
			if (QWEN_TOKEN_PLAN_EXCLUDED_MODEL_IDS.has(modelId)) continue;
			if (modelIds && !modelIds.has(modelId)) continue;
			const thinkingLevelMap =
				getEffortThinkingLevelMap(m.reasoning_options ?? []) ??
				(QWEN_TOKEN_PLAN_REASONING_EFFORT_FALLBACK_MODEL_IDS.has(modelId)
					? QWEN_TOKEN_PLAN_FALLBACK_THINKING_LEVEL_MAP
					: undefined);

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider,
				baseUrl,
				compat: thinkingLevelMap ? qwenTokenPlanCompat : { ...qwenTokenPlanCompat, supportsReasoningEffort: false },
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
			emittedModelIds?.add(modelId);
		}

		if (modelIds && emittedModelIds && generatorOptions.strict) {
			assertExactModelIds(provider, modelIds, emittedModelIds);
		}
	}
}
