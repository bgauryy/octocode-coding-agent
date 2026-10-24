import type { AnthropicMessagesCompat, Api, Model, OpenAICompletionsCompat } from "../../src/types.ts";
import { withGoogleVertexPricing } from "../../src/utils/google-vertex-pricing.ts";
import { getEffortThinkingLevelMap } from "../models-dev-reasoning-options.ts";
import {
	FIREWORKS_ADAPTIVE_THINKING_FALLBACK_MODELS,
	KIMI_K3_COST,
	KIMI_K3_OPENAI_COMPAT,
	KIMI_OPENAI_COMPAT,
	VERTEX_BASE_URL,
	ZAI_TOOL_STREAM_UNSUPPORTED_MODELS,
} from "./constants.ts";
import { getModelsDevCost } from "./pricing.ts";
import { getGoogleThinkingLevelMap, recordModelsDevReasoningOptions } from "./thinking-levels.ts";
import type { ModelsDevCatalog, ModelsDevModel, ModelsDevProvider } from "./types.ts";

/** models.dev providers whose models need their own processing: Z.ai, Baseten, Google, Fireworks and Kimi For Coding. */

export function processZaiModels(data: ModelsDevCatalog): Model<Api>[] {
	const variants = [
		{
			source: "zai-coding-plan",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
		},
		{
			source: "zhipuai-coding-plan",
			provider: "zai-coding-cn",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		},
	] as const;
	const models: Model<Api>[] = [];

	for (const { source, provider, baseUrl } of variants) {
		for (const [modelId, model] of Object.entries(data[source]?.models ?? {})) {
			const m = model;
			if (m.tool_call !== true) continue;
			const supportsImage = m.modalities?.input?.includes("image");

			const thinkingLevelMap = getEffortThinkingLevelMap(m.reasoning_options ?? []);
			const isGlm52 = modelId === "glm-5.2" || modelId === "glm-5.2-highspeed";
			if (thinkingLevelMap && isGlm52) {
				thinkingLevelMap.off = "none";
			}
			const supportsReasoningEffort = thinkingLevelMap !== undefined;
			const referenceCost = data.zai?.models?.[modelId]?.cost ?? m.cost;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider,
				baseUrl,
				reasoning: m.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: supportsImage ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(referenceCost),
				compat: {
					supportsDeveloperRole: false,
					thinkingFormat: "zai",
					...(supportsReasoningEffort ? { supportsReasoningEffort: true } : {}),
					...(!ZAI_TOOL_STREAM_UNSUPPORTED_MODELS.has(modelId) ? { zaiToolStream: true } : {}),
				},
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
			recordModelsDevReasoningOptions(provider, modelId, m);
		}
	}

	return models;
}

export function processBasetenModels(provider: ModelsDevProvider | undefined): Model<Api>[] {
	if (!provider?.models) return [];

	const baseUrl = "https://inference.baseten.co/v1";
	const baseCompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
		supportsStrictMode: true,
		// Baseten automatic prompt caching needs session affinity so related
		// requests land on the same replica. See:
		// https://docs.baseten.co/inference/model-apis/pricing-and-limits
		sendSessionAffinityHeaders: true,
		supportsLongCacheRetention: false,
	};
	const reasoningEffortCompat: OpenAICompletionsCompat = {
		...baseCompat,
		supportsReasoningEffort: true,
		thinkingFormat: "openai",
	};
	const toggleReasoningCompat: OpenAICompletionsCompat = {
		...baseCompat,
		thinkingFormat: "baseten",
		chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
	};
	const toggleReasoningEffortCompat: OpenAICompletionsCompat = {
		...reasoningEffortCompat,
		thinkingFormat: "baseten",
		chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
	};
	const toggleThinkingLevelMap = {
		off: "off",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	} as const;
	const glm52ThinkingLevelMap = {
		off: "none",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	} as const;
	const models: Model<Api>[] = [];

	for (const [modelId, model] of Object.entries(provider.models)) {
		if (model.status === "deprecated") continue;

		const reasoning = model.reasoning === true;
		const reasoningOptions = model.reasoning_options ?? [];
		const isGlm52 = modelId === "zai-org/GLM-5.2" || modelId === "zai-org/GLM-5.2-Fast";
		const supportsToggle = reasoningOptions.some((option) => option.type === "toggle") || isGlm52;
		const supportsEffort = reasoningOptions.some((option) => option.type === "effort") || isGlm52;
		const compat =
			supportsToggle && supportsEffort
				? toggleReasoningEffortCompat
				: supportsToggle
					? toggleReasoningCompat
					: supportsEffort
						? reasoningEffortCompat
						: baseCompat;
		const thinkingLevelMap = isGlm52
			? glm52ThinkingLevelMap
			: supportsToggle
				? toggleThinkingLevelMap
				: getEffortThinkingLevelMap(reasoningOptions);
		// Baseten's GLM-5.2 endpoints are text-only despite models.dev reporting image input.
		const supportsImageInput = !isGlm52 && model.modalities?.input?.includes("image");

		models.push({
			id: modelId,
			name: model.name || modelId,
			api: "openai-completions",
			provider: "baseten",
			baseUrl,
			reasoning,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: supportsImageInput ? ["text", "image"] : ["text"],
			cost: getModelsDevCost(model.cost),
			compat,
			contextWindow: model.limit?.context || 4096,
			maxTokens: model.limit?.output || 4096,
		});
	}

	return models;
}

export function processGoogleModels(data: ModelsDevCatalog): Model<Api>[] {
	const models: Model<Api>[] = [];
	const googleModels = data.google?.models;
	if (googleModels) {
		for (const [modelId, model] of Object.entries(googleModels)) {
			if (model.tool_call !== true) continue;
			const source =
				modelId === "gemini-flash-latest"
					? (googleModels["gemini-3.5-flash"] ?? model)
					: modelId === "gemini-flash-lite-latest"
						? (googleModels["gemini-3.1-flash-lite"] ?? model)
						: model;
			const thinkingLevelMap = getGoogleThinkingLevelMap(modelId, source.reasoning_options ?? []);

			models.push({
				id: modelId,
				name: model.name || modelId,
				api: "google-generative-ai",
				provider: "google",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				reasoning: source.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(source.cost),
				contextWindow: source.limit?.context || 4096,
				maxTokens: source.limit?.output || 4096,
			});
		}
	}

	// The google-vertex models.dev catalog also includes Claude, OpenAI, and other
	// MaaS models that do not use the @google/genai Gemini streaming path.
	const vertexModels = data["google-vertex"]?.models;
	if (vertexModels) {
		for (const [modelId, model] of Object.entries(vertexModels)) {
			if (model.tool_call !== true || !modelId.startsWith("gemini-")) continue;
			if (modelId === "gemini-3.1-flash-lite-preview") continue;
			const source =
				modelId === "gemini-flash-latest"
					? (vertexModels["gemini-3.5-flash"] ?? model)
					: modelId === "gemini-flash-lite-latest"
						? (vertexModels["gemini-3.1-flash-lite"] ?? model)
						: model;
			const thinkingLevelMap = getGoogleThinkingLevelMap(modelId, source.reasoning_options ?? []);
			// models.dev reports Vertex cache_read/cache_write values for Gemini 2.5 Flash that
			// do not match the official Gemini API standard pricing table. Usage only accounts
			// cachedContentTokenCount as cacheRead.
			const cacheRead = modelId === "gemini-2.5-flash" ? 0.03 : source.cost?.cache_read || 0;
			const cost = getModelsDevCost(source.cost);

			models.push(
				withGoogleVertexPricing({
					id: modelId,
					name: model.name || modelId,
					api: "google-vertex",
					provider: "google-vertex",
					baseUrl: VERTEX_BASE_URL,
					reasoning: source.reasoning === true,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						...cost,
						cacheRead,
						cacheWrite: 0,
						...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier, cacheWrite: 0 })) } : {}),
					},
					contextWindow: source.limit?.context || 4096,
					maxTokens: source.limit?.output || 4096,
				}),
			);
		}
	}

	return models;
}

export function processFireworksModels(provider: ModelsDevProvider | undefined): Model<Api>[] {
	if (!provider?.models) return [];

	const anthropicCompat: AnthropicMessagesCompat = {
		allowEmptySignature: true,
		sendSessionAffinityHeaders: true,
		supportsEagerToolInputStreaming: false,
		supportsCacheControlOnTools: false,
		supportsLongCacheRetention: false,
	};
	const openAICompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		sendSessionAffinityHeaders: true,
		supportsLongCacheRetention: false,
	};
	const kimiK3Compat: OpenAICompletionsCompat = {
		...openAICompat,
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "openai",
	};
	const models: Model<Api>[] = [];

	for (const [modelId, model] of Object.entries(provider.models)) {
		if (model.tool_call !== true) continue;

		const input: ("text" | "image")[] = model.modalities?.input?.includes("image") ? ["text", "image"] : ["text"];
		const common = {
			id: modelId,
			name: model.name || modelId,
			provider: "fireworks",
			reasoning: model.reasoning === true,
			input,
			cost: getModelsDevCost(model.cost),
			contextWindow: model.limit?.context || 4096,
			maxTokens: model.limit?.output || 4096,
		};

		if (modelId.includes("glm-")) {
			models.push({
				...common,
				api: "openai-completions",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				compat: openAICompat,
			});
		} else if (modelId.includes("kimi-k3")) {
			models.push({
				...common,
				api: "openai-completions",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				compat: kimiK3Compat,
			});
		} else {
			models.push({
				...common,
				api: "anthropic-messages",
				// Fireworks Anthropic-compatible API - SDK appends /v1/messages.
				baseUrl: "https://api.fireworks.ai/inference",
				// Fireworks prompt caching uses automatic prefix matching + session affinity.
				// x-session-affinity routes requests to the same replica for cache hits.
				// cache_control on tools and eager_input_streaming are not supported.
				// See: https://docs.fireworks.ai/tools-sdks/anthropic-compatibility
				// Use adaptive thinking for cataloged effort controls, with verified
				// fallbacks where models.dev is incomplete. New models need no allowlist entry.
				compat: {
					...anthropicCompat,
					...(model.reasoning_options?.some((option) => option.type === "effort") ||
					FIREWORKS_ADAPTIVE_THINKING_FALLBACK_MODELS.has(modelId)
						? { forceAdaptiveThinking: true }
						: {}),
				},
			});
		}
		recordModelsDevReasoningOptions("fireworks", modelId, model);
	}

	return models;
}

// Kimi Coding is subscription-backed, so models.dev reports zero cost. Use the
// equivalent Moonshot API rates to estimate the value of subscription usage.
const KIMI_CODING_IMPLIED_COSTS: Record<string, Model<Api>["cost"]> = {
	k3: KIMI_K3_COST,
	"kimi-for-coding": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	"kimi-for-coding-highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
};
// Models whose https://api.kimi.com/coding/v1/models entry reports effort levels and
// dynamic tool loading (tools declared in later system messages). Highspeed reports
// neither and rejects tool-bearing system messages with a 400.
const KIMI_CODING_K3_STYLE_MODEL_IDS = new Set(["k3", "k3-256k", "kimi-for-coding"]);

// Kimi Coding uses Chat Completions, the same protocol as the official Kimi Code client.
export function createKimiCodingModels(kimiModels: Record<string, ModelsDevModel>): Model<"openai-completions">[] {
	const models: Model<"openai-completions">[] = [];
	for (const [modelId, m] of Object.entries(kimiModels)) {
		if (m.tool_call !== true) continue;

		const isK3Style = KIMI_CODING_K3_STYLE_MODEL_IDS.has(modelId);
		const impliedCost = KIMI_CODING_IMPLIED_COSTS[modelId];
		// K3-style models send reasoning_effort, so expose the effort values models.dev lists.
		const effortLevels = isK3Style && m.reasoning_options ? getEffortThinkingLevelMap(m.reasoning_options) : undefined;

		models.push({
			id: modelId,
			name: m.name || modelId,
			api: "openai-completions",
			provider: "kimi-coding",
			baseUrl: "https://api.kimi.com/coding/v1",
			compat: {
				...(isK3Style ? KIMI_K3_OPENAI_COMPAT : KIMI_OPENAI_COMPAT),
				// All models accept system text after the conversation starts.
				supportsMidConvoSystemMessages: true,
				...(isK3Style ? { supportsMidConvoToolAdditions: true } : {}),
			},
			reasoning: m.reasoning === true,
			input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
			cost: {
				input: m.cost?.input || impliedCost?.input || 0,
				output: m.cost?.output || impliedCost?.output || 0,
				cacheRead: m.cost?.cache_read || impliedCost?.cacheRead || 0,
				cacheWrite: m.cost?.cache_write || impliedCost?.cacheWrite || 0,
			},
			contextWindow: m.limit?.context || 4096,
			maxTokens: m.limit?.output || 4096,
			// Kimi Code reports every model as always-thinking.
			thinkingLevelMap: { ...effortLevels, off: null },
		});
	}
	return models;
}
