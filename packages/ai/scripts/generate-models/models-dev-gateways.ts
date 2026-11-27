import {
	getEffortThinkingLevelMap,
	getModelsDevCost,
	modelsDevInput,
	modelsDevLimits,
	modelsDevReasoning,
	modelsDevToolCall,
} from "../../src/catalog/models-dev-fields.ts";
import { getOpenCodeBaseUrl } from "../../src/providers/opencode-endpoints.ts";
import type {
	AnthropicMessagesCompat,
	Api,
	Model,
	ModelPromptCache,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "../../src/types.ts";
import { getAnthropicMessagesCompat } from "./anthropic.ts";
import {
	COPILOT_STATIC_HEADERS,
	OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS,
} from "./constants.ts";
import { getOpenCodeAnthropicCacheMetadata } from "./opencode.ts";
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
		const variantModels = data[variant.key]?.models;
		if (!variantModels) continue;

		for (const [modelId, model] of Object.entries(variantModels)) {
			const m = model;
			if (!modelsDevToolCall(m)) continue;
			if (m.status === "deprecated") continue;

			const npm = m.provider?.npm;
			let api: Api;
			let compat: AnthropicMessagesCompat | OpenAICompletionsCompat | OpenAIResponsesCompat | undefined;
			let promptCache: ModelPromptCache | undefined;

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

			if (api === "anthropic-messages") {
				const cacheMetadata = getOpenCodeAnthropicCacheMetadata(modelId);
				promptCache = cacheMetadata.promptCache;
				if (cacheMetadata.compat) compat = { ...compat, ...cacheMetadata.compat };
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
				reasoning: modelsDevReasoning(m),
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: modelsDevInput(m.modalities),
				cost: getModelsDevCost(m.cost),
				...(compat ? { compat } : {}),
				...(promptCache ? { promptCache } : {}),
				...modelsDevLimits(m.limit),
			});
			recordModelsDevReasoningOptions(variant.provider, modelId, m);
		}
	}

	// Process GitHub Copilot models
	if (data["github-copilot"]?.models) {
		for (const [modelId, model] of Object.entries(data["github-copilot"].models)) {
			const m = model;
			if (!modelsDevToolCall(m)) continue;
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
				reasoning: modelsDevReasoning(m),
				input: modelsDevInput(m.modalities),
				cost: getModelsDevCost(m.cost),
				...modelsDevLimits(m.limit, { contextWindow: 128000, maxTokens: 8192 }),
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
