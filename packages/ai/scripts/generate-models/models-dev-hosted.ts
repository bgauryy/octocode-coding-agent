import type { Model } from "../../src/types.ts";
import { getEffortThinkingLevelMap } from "../models-dev-reasoning-options.ts";
import {
	NVIDIA_BASE_URL,
	NVIDIA_HEADERS,
	NVIDIA_NIM_UNSUPPORTED_MODELS,
	NVIDIA_OPENAI_COMPAT,
	TOGETHER_BASE_URL,
	XAI_RESPONSES_COMPAT,
} from "./constants.ts";
import { normalizeNvidiaModelId } from "./fetchers.ts";
import { getModelsDevCost, roundCost } from "./pricing.ts";
import { processBasetenModels, processFireworksModels, processZaiModels } from "./processors.ts";
import { getTogetherCompat, getTogetherThinkingLevelMap, recordModelsDevReasoningOptions } from "./thinking-levels.ts";
import type { ModelsDevCatalog } from "./types.ts";

/** models.dev providers xAI, Meta, Z.ai, Mistral, Hugging Face, Fireworks, NVIDIA NIM, Together AI and Baseten. */
export function addModelsDevHostedModels(
	data: ModelsDevCatalog,
	models: Model<any>[],
	nvidiaNimModelIds: Map<string, string>,
): void {
	// Process xAi models
	if (data.xai?.models) {
		for (const [modelId, model] of Object.entries(data.xai.models)) {
			const m = model;
			if (m.tool_call !== true) continue;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-responses",
				provider: "xai",
				baseUrl: "https://api.x.ai/v1",
				compat: { ...XAI_RESPONSES_COMPAT },
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
			recordModelsDevReasoningOptions("xai", modelId, m);
		}
	}

	// Process Meta models
	if (data.meta?.models) {
		for (const [modelId, model] of Object.entries(data.meta.models)) {
			const m = model;
			if (m.tool_call !== true) continue;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-responses",
				provider: "meta",
				baseUrl: "https://api.meta.ai/v1",
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
			recordModelsDevReasoningOptions("meta", modelId, m);
		}
	}

	models.push(...processZaiModels(data));

	// Process Mistral models
	if (data.mistral?.models) {
		for (const [modelId, model] of Object.entries(data.mistral.models)) {
			const m = model;
			if (m.tool_call !== true) continue;

			// Models with effort values use `reasoning_effort` with these levels.
			// Reasoning models without them (Magistral) use `prompt_mode`.
			const thinkingLevelMap = getEffortThinkingLevelMap(m.reasoning_options ?? []);

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "mistral-conversations",
				provider: "mistral",
				baseUrl: "https://api.mistral.ai",
				reasoning: m.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: {
					input: m.cost?.input || 0,
					output: m.cost?.output || 0,
					cacheRead: m.cost?.cache_read ?? (m.cost?.input ? roundCost(m.cost.input * 0.1) : 0),
					cacheWrite: m.cost?.cache_write || 0,
				},
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
		}
	}

	// Process Hugging Face models
	if (data.huggingface?.models) {
		for (const [modelId, model] of Object.entries(data.huggingface.models)) {
			const m = model;
			if (m.tool_call !== true) continue;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider: "huggingface",
				baseUrl: "https://router.huggingface.co/v1",
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				compat: {
					supportsDeveloperRole: false,
				},
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
			recordModelsDevReasoningOptions("huggingface", modelId, m);
		}
	}

	models.push(...processFireworksModels(data["fireworks-ai"]));

	// Process NVIDIA NIM models
	if (data.nvidia?.models) {
		for (const [modelId, model] of Object.entries(data.nvidia.models)) {
			const m = model;
			if (m.tool_call !== true) continue;
			if (!m.modalities?.input?.includes("text")) continue;
			if (!m.modalities?.output?.includes("text")) continue;

			const liveModelId = nvidiaNimModelIds.get(modelId) ?? nvidiaNimModelIds.get(normalizeNvidiaModelId(modelId));
			if (!liveModelId) continue;
			if (NVIDIA_NIM_UNSUPPORTED_MODELS.has(liveModelId)) continue;

			models.push({
				id: liveModelId,
				name: m.name || liveModelId,
				api: "openai-completions",
				provider: "nvidia",
				baseUrl: NVIDIA_BASE_URL,
				headers: { ...NVIDIA_HEADERS },
				reasoning: m.reasoning === true,
				input: m.modalities.input.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				compat: NVIDIA_OPENAI_COMPAT,
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
			recordModelsDevReasoningOptions("nvidia", liveModelId, m);
		}
	}

	// Process Together AI models
	const togetherProvider = data.together ?? data.togetherai ?? data["together-ai"];
	if (togetherProvider?.models) {
		for (const [modelId, model] of Object.entries(togetherProvider.models)) {
			const m = model;
			if (m.tool_call !== true) continue;
			if (m.status === "deprecated") continue;

			const reasoning = m.reasoning === true;
			const thinkingLevelMap = getTogetherThinkingLevelMap(modelId, reasoning);
			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider: "together",
				baseUrl: TOGETHER_BASE_URL,
				reasoning,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				compat: getTogetherCompat(modelId, reasoning),
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
			recordModelsDevReasoningOptions("together", modelId, m);
		}
	}

	models.push(...processBasetenModels(data.baseten));
}
