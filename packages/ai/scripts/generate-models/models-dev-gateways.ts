import { getOpenCodeBaseUrl } from "../../src/providers/opencode-endpoints.ts";
import type { Api, Model, OpenAICompletionsCompat, OpenAIResponsesCompat } from "../../src/types.ts";
import { getEffortThinkingLevelMap } from "../models-dev-reasoning-options.ts";
import { getAnthropicMessagesCompat } from "./anthropic.ts";
import {
	COPILOT_STATIC_HEADERS,
	OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS,
} from "./constants.ts";
import { getModelsDevCost } from "./pricing.ts";
import { getGoogleThinkingLevelMap, recordModelsDevReasoningOptions } from "./thinking-levels.ts";
import type { ModelsDevCatalog } from "./types.ts";

/** models.dev gateways: OpenCode (Zen and Go) and GitHub Copilot. */
export function addModelsDevGatewayModels(data: ModelsDevCatalog, models: Model<any>[]): void {
	// Process OpenCode models (Zen and Go)
	// API mapping based on provider.npm field:
	// - @ai-sdk/openai → openai-responses
	// - @ai-sdk/anthropic → anthropic-messages
	// - @ai-sdk/google → google-generative-ai
	// - null/undefined/@ai-sdk/openai-compatible → openai-completions
	const opencodeVariants = [
		{ key: "opencode", provider: "opencode" },
		{ key: "opencode-go", provider: "opencode-go" },
	] as const;

	for (const variant of opencodeVariants) {
		if (!data[variant.key]?.models) continue;

		for (const [modelId, model] of Object.entries(data[variant.key].models)) {
			const m = model;
			if (m.tool_call !== true) continue;
			if (m.status === "deprecated") continue;

			const npm = m.provider?.npm;
			let api: Api;
			let compat: OpenAICompletionsCompat | OpenAIResponsesCompat | undefined;

			if (npm === "@ai-sdk/openai") {
				api = "openai-responses";
				compat = { sessionAffinityFormat: "openai-nosession" };
			} else if (npm === "@ai-sdk/anthropic") {
				api = "anthropic-messages";
			} else if (npm === "@ai-sdk/google") {
				api = "google-generative-ai";
			} else if (npm === "@ai-sdk/alibaba") {
				api = "openai-completions";
				compat = { cacheControlFormat: "anthropic" };
			} else {
				// null, undefined, or @ai-sdk/openai-compatible
				api = "openai-completions";
			}

			if (variant.provider === "opencode" && modelId === "grok-build-0.1") {
				compat = { ...compat, supportsReasoningEffort: false };
			}

			if ((variant.provider === "opencode" || variant.provider === "opencode-go") && modelId === "kimi-k2.6") {
				// OpenCode Kimi K2.6 accepts Anthropic-style thinking objects
				// and rejects string thinking values or combined reasoning_effort.
				compat = { ...compat, thinkingFormat: "deepseek", supportsReasoningEffort: false };
			}

			// Fix known mismatches between models.dev npm data and actual
			// OpenCode Go endpoint behaviour. models.dev reports these models
			// as @ai-sdk/anthropic, but OpenCode Go serves them through the
			// OpenAI-compatible /v1/chat/completions path.
			if (variant.provider === "opencode-go") {
				if (modelId === "qwen3.5-plus" || modelId === "qwen3.6-plus") {
					api = "openai-completions";
					// Qwen/DashScope uses enable_thinking at the top level.
					compat = { ...compat, thinkingFormat: "qwen" };
				}
			}

			if (api === "openai-completions") {
				compat = { ...compat, maxTokensField: "max_tokens" };
				if (OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS.has(`${variant.provider}:${modelId}`)) {
					compat = { ...compat, supportsLongCacheRetention: false };
				}
			}

			let thinkingLevelMap: NonNullable<Model<Api>["thinkingLevelMap"]> | undefined;
			if (api === "google-generative-ai") {
				thinkingLevelMap = getGoogleThinkingLevelMap(modelId, m.reasoning_options ?? []);
			} else if (variant.provider === "opencode-go" && modelId === "deepseek-v4.1-flash") {
				thinkingLevelMap = getEffortThinkingLevelMap(m.reasoning_options ?? []);
			}
			models.push({
				id: modelId,
				name: m.name || modelId,
				api,
				provider: variant.provider,
				baseUrl: getOpenCodeBaseUrl(variant.provider, api),
				reasoning: m.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				...(compat ? { compat } : {}),
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
			recordModelsDevReasoningOptions(variant.provider, modelId, m);
		}
	}

	// Process GitHub Copilot models
	if (data["github-copilot"]?.models) {
		for (const [modelId, model] of Object.entries(data["github-copilot"].models)) {
			const m = model;
			if (m.tool_call !== true) continue;
			if (m.status === "deprecated") continue;

			// Claude 4.x and 5.x models route to Anthropic Messages API
			const isCopilotClaude = /^claude-(haiku|sonnet|opus|fable)-[45]([.-]|$)/.test(modelId);
			// GPT, Grok, OSWE, and MAI-Code models are only served through
			// the Copilot /responses endpoint.
			const needsResponsesApi =
				modelId.startsWith("gpt-") ||
				modelId.startsWith("grok-") ||
				modelId.startsWith("oswe") ||
				modelId.startsWith("mai-");

			const api: Api = isCopilotClaude
				? "anthropic-messages"
				: needsResponsesApi
					? "openai-responses"
					: "openai-completions";

			const anthropicCompat =
				api === "anthropic-messages" ? getAnthropicMessagesCompat("github-copilot", modelId) : undefined;

			const copilotModel: Model<any> = {
				id: modelId,
				name: m.name || modelId,
				api,
				provider: "github-copilot",
				baseUrl: "https://api.individual.githubcopilot.com",
				reasoning: m.reasoning === true,
				input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: getModelsDevCost(m.cost),
				contextWindow: m.limit?.context || 128000,
				maxTokens: m.limit?.output || 8192,
				headers: { ...COPILOT_STATIC_HEADERS },
				...(anthropicCompat ? { compat: anthropicCompat } : {}),
				// compat only applies to openai-completions
				...(api === "openai-completions"
					? {
							compat: {
								supportsStore: false,
								supportsDeveloperRole: false,
								supportsReasoningEffort: false,
							},
						}
					: {}),
			};

			models.push(copilotModel);
			recordModelsDevReasoningOptions("github-copilot", modelId, m);
		}
	}
}
