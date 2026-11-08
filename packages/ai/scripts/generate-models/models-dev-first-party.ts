import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_BASE_URL,
} from "../../src/api/cloudflare.ts";
import type { Model } from "../../src/types.ts";
import {
	BEDROCK_END_OF_LIFE_MODEL_IDS,
	BEDROCK_INFERENCE_PROFILE_ONLY_MODEL_IDS,
	MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS,
} from "./constants.ts";
import { getModelsDevCost } from "./pricing.ts";
import { processGoogleModels } from "./processors.ts";
import { recordModelsDevReasoningOptions } from "./thinking-levels.ts";
import type { ModelsDevCatalog } from "./types.ts";
import { nonZeroOr } from "../../src/utils/non-zero.ts";

function getBedrockBaseUrl(modelId: string): string {
	return modelId.startsWith("eu.")
		? "https://bedrock-runtime.eu-central-1.amazonaws.com"
		: "https://bedrock-runtime.us-east-1.amazonaws.com";
}

/** models.dev providers served by their own APIs: Amazon Bedrock, Anthropic, Google, OpenAI, Groq, Cerebras and Cloudflare. */
export function addModelsDevFirstPartyModels(data: ModelsDevCatalog, models: Model<any>[]): void {
	// Process Amazon Bedrock models
	if (data["amazon-bedrock"]?.models) {
		for (const [modelId, model] of Object.entries(data["amazon-bedrock"].models)) {
			const m = model;
			if (m.tool_call !== true) continue;
			// models.dev marks some models deprecated that AWS still serves; only end-of-life ones are left out.
			if (BEDROCK_END_OF_LIFE_MODEL_IDS.has(modelId)) continue;
			if (BEDROCK_INFERENCE_PROFILE_ONLY_MODEL_IDS.has(modelId)) continue;

			const id = modelId;

			if (id.startsWith("ai21.jamba")) {
				// These models doesn't support tool use in streaming mode
				continue;
			}

			if (id.startsWith("mistral.mistral-7b-instruct-v0")) {
				// These models doesn't support system messages
				continue;
			}

			models.push({
				id,
				name: m.name || id,
				api: "bedrock-converse-stream" as const,
				provider: "amazon-bedrock" as const,
				baseUrl: getBedrockBaseUrl(id),
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				// Includes models.dev pricing tiers, e.g. the long-context tier for OpenAI models (#10326).
				cost: getModelsDevCost(m.cost),
				contextWindow: nonZeroOr(4096, m.limit?.context),
				maxTokens: nonZeroOr(4096, m.limit?.output),
				...(m.structured_output === true && { compat: { supportsStrictMode: true } }),
			});
			recordModelsDevReasoningOptions("amazon-bedrock" as const, id, m);
		}
	}

	// Process Anthropic models
	if (data.anthropic?.models) {
		for (const [modelId, model] of Object.entries(data.anthropic.models)) {
			const m = model;
			if (m.tool_call !== true) continue;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: nonZeroOr(4096, m.limit?.context),
				maxTokens: nonZeroOr(4096, m.limit?.output),
			});
			recordModelsDevReasoningOptions("anthropic", modelId, m);
		}
	}

	models.push(...processGoogleModels(data));

	// Process OpenAI models
	if (data.openai?.models) {
		for (const [modelId, model] of Object.entries(data.openai.models)) {
			const m = model;
			if (m.tool_call !== true) continue;
			// models.dev lists this alias, but it is not accepted by OpenAI APIs.
			if (MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS.has(modelId)) continue;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-responses",
				provider: "openai",
				baseUrl: "https://api.openai.com/v1",
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: nonZeroOr(4096, m.limit?.context),
				maxTokens: nonZeroOr(4096, m.limit?.output),
			});
			recordModelsDevReasoningOptions("openai", modelId, m);
		}
	}

	// Process Groq models
	if (data.groq?.models) {
		for (const [modelId, model] of Object.entries(data.groq.models)) {
			const m = model;
			if (m.tool_call !== true) continue;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider: "groq",
				baseUrl: "https://api.groq.com/openai/v1",
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: nonZeroOr(4096, m.limit?.context),
				maxTokens: nonZeroOr(4096, m.limit?.output),
			});
			recordModelsDevReasoningOptions("groq", modelId, m);
		}
	}

	// Process Cerebras models
	if (data.cerebras?.models) {
		for (const [modelId, model] of Object.entries(data.cerebras.models)) {
			const m = model;
			if (m.tool_call !== true) continue;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider: "cerebras",
				baseUrl: "https://api.cerebras.ai/v1",
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: nonZeroOr(4096, m.limit?.context),
				maxTokens: nonZeroOr(4096, m.limit?.output),
			});
			recordModelsDevReasoningOptions("cerebras", modelId, m);
		}
	}

	// Process Cloudflare Workers AI models
	if (data["cloudflare-workers-ai"]?.models) {
		for (const [modelId, model] of Object.entries(data["cloudflare-workers-ai"].models)) {
			const m = model;
			if (m.tool_call !== true) continue;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider: "cloudflare-workers-ai",
				baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: nonZeroOr(4096, m.limit?.context),
				maxTokens: nonZeroOr(4096, m.limit?.output),
				compat: { sendSessionAffinityHeaders: true },
			});
			recordModelsDevReasoningOptions("cloudflare-workers-ai", modelId, m);
		}
	}

	// Process Cloudflare AI Gateway models
	const cloudflareAIGatewayModelIds = new Set<string>();
	if (data["cloudflare-ai-gateway"]?.models) {
		for (const [prefixedId, model] of Object.entries(data["cloudflare-ai-gateway"].models)) {
			const m = model;
			if (m.tool_call !== true) continue;

			const slashIdx = prefixedId.indexOf("/");
			if (slashIdx === -1) continue;
			const upstream = prefixedId.slice(0, slashIdx);
			const nativeId = prefixedId.slice(slashIdx + 1);

			let api: "anthropic-messages" | "openai-completions" | "openai-responses";
			let baseUrl: string;
			let id: string;
			if (upstream === "openai") {
				api = "openai-responses";
				baseUrl = CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL;
				id = nativeId;
			} else if (upstream === "anthropic") {
				api = "anthropic-messages";
				baseUrl = CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL;
				// The /anthropic passthrough forwards the model ID to Anthropic unchanged.
				// models.dev lists dotted versions (claude-opus-5.5), but Anthropic only
				// accepts dashed IDs (claude-opus-5-5).
				id = nativeId.replaceAll(".", "-");
			} else if (upstream === "workers-ai") {
				api = "openai-completions";
				baseUrl = CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL;
				id = prefixedId;
			} else {
				continue;
			}

			// Gateway passthroughs forward session affinity headers to upstreams that
			// use them for cache/routing affinity.
			const compat =
				upstream === "anthropic" || upstream === "workers-ai" ? { sendSessionAffinityHeaders: true } : undefined;

			cloudflareAIGatewayModelIds.add(id);
			models.push({
				id,
				name: m.name || id,
				api,
				provider: "cloudflare-ai-gateway",
				baseUrl,
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: nonZeroOr(4096, m.limit?.context),
				maxTokens: nonZeroOr(4096, m.limit?.output),
				...(compat ? { compat } : {}),
			});
			recordModelsDevReasoningOptions("cloudflare-ai-gateway", id, m);
		}
	}

	// The gateway proxies Workers AI through its OpenAI-compatible /compat endpoint,
	// but models.dev may omit or intermittently drop those `workers-ai/*` entries
	// from the AI Gateway catalog. Mirror the Workers AI catalog under the documented
	// prefix so the gateway keeps its OpenAI-compatible models stable.
	if (data["cloudflare-workers-ai"]?.models) {
		for (const [modelId, model] of Object.entries(data["cloudflare-workers-ai"].models)) {
			const m = model;
			if (m.tool_call !== true) continue;

			const id = `workers-ai/${modelId}`;
			if (cloudflareAIGatewayModelIds.has(id)) continue;
			cloudflareAIGatewayModelIds.add(id);

			models.push({
				id,
				name: m.name || id,
				api: "openai-completions",
				provider: "cloudflare-ai-gateway",
				baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: nonZeroOr(4096, m.limit?.context),
				maxTokens: nonZeroOr(4096, m.limit?.output),
				compat: { sendSessionAffinityHeaders: true },
			});
			recordModelsDevReasoningOptions("cloudflare-ai-gateway", id, m);
		}
	}
}
