/**
 * One normalized view of what a model accepts and how its requests are shaped: limits, input modalities, thinking
 * control and cache mechanism. Adapters, the application and its UI read capabilities from here instead of deriving
 * them again from API names, provider names or model IDs.
 */
import { getAnthropicCompat } from "../api/anthropic-messages/compat.ts";
import {
	isAnthropicClaudeModel,
	supportsAdaptiveThinking,
	supportsPromptCaching,
} from "../api/bedrock-converse-stream/model-match.ts";
import { usesGoogleThinkingLevel } from "../api/google-shared/thinking-format.ts";
import { getCompat as getCompletionsCompat } from "../api/openai-completions/compat.ts";
import { getCompat as getResponsesCompat } from "../api/openai-responses/compat.ts";
import type { Api, Model, ModelThinkingLevel, ProviderEnv } from "../types.ts";
import { getSupportedThinkingLevels } from "./model-helpers.ts";

/**
 * How thinking is requested: `effort` names a level, `budget` sends a token budget, `level` is Gemini's discrete
 * `thinkingLevel`, `none` means the model does not reason.
 */
export type ThinkingControl = "none" | "effort" | "budget" | "level";

/**
 * How a prompt prefix is cached: `markers` are Anthropic-style breakpoints with 5-minute and 1-hour tiers, `key` is a
 * routing key with provider-managed retention, `explicit-breakpoint` is OpenAI's explicit cache mode, `implicit` is
 * provider-managed caching with nothing to send, `none` caches nothing.
 */
export type CacheMechanism = "markers" | "key" | "explicit-breakpoint" | "implicit" | "none";

export interface ModelCapabilities {
	/** The model's capacity in tokens; a session's working budget is applied separately. */
	contextWindow: number;
	maxOutputTokens: number;
	input: Model<Api>["input"];
	thinking: { control: ThinkingControl; levels: ModelThinkingLevel[]; canDisable: boolean };
	cache: { mechanism: CacheMechanism; lifetimes: { short?: number; long?: number } };
}

/** Anthropic marker lifetimes in seconds: 5 minutes, and 1 hour where the endpoint accepts it. */
const MARKER_LIFETIMES = { short: 300, long: 3600 } as const;
/** OpenAI explicit cache mode lifetimes in seconds: 30 minutes and 12 hours. */
const EXPLICIT_LIFETIMES = { short: 1800, long: 43_200 } as const;
/** OpenAI extended retention for implicit caching (`prompt_cache_retention: "24h"`), in seconds. */
const EXTENDED_KEY_LIFETIME = 86_400;

export function resolveModelCapabilities(model: Model<Api>, env?: ProviderEnv): ModelCapabilities {
	const levels = getSupportedThinkingLevels(model);
	return {
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		input: model.input,
		thinking: { control: thinkingControl(model), levels, canDisable: levels.includes("off") },
		cache: cacheCapability(model, env),
	};
}

function thinkingControl(model: Model<Api>): ThinkingControl {
	if (!model.reasoning) return "none";
	switch (model.api) {
		case "anthropic-messages":
			return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking ? "effort" : "budget";
		case "bedrock-converse-stream":
			return supportsAdaptiveThinking(model.id, model.name) ? "effort" : "budget";
		case "google-generative-ai":
		case "google-vertex":
			return usesGoogleThinkingLevel(model as Model<"google-generative-ai">) ? "level" : "budget";
		case "openai-completions": {
			const compat = getCompletionsCompat(model as Model<"openai-completions">);
			if (compat.supportsThinkingTokenBudget) return "budget";
			return compat.supportsReasoningEffort ? "effort" : "none";
		}
		default:
			return "effort";
	}
}

function cacheCapability(model: Model<Api>, env?: ProviderEnv): ModelCapabilities["cache"] {
	const mechanism = cacheMechanism(model, env);
	// The long tier exists only where the adapter sends it (resolved compat); a declared lifetime sets its length.
	const declared = model.promptCache ?? {};
	const long = supportsLongRetention(model);
	const tiers = (short: number | undefined, longDefault: number | undefined) => ({
		...(short !== undefined ? { short } : {}),
		...(long && longDefault !== undefined ? { long: longDefault } : {}),
	});
	if (mechanism === "markers")
		return {
			mechanism,
			lifetimes: tiers(declared.short ?? MARKER_LIFETIMES.short, declared.long ?? MARKER_LIFETIMES.long),
		};
	if (mechanism === "explicit-breakpoint")
		return {
			mechanism,
			lifetimes: tiers(declared.short ?? EXPLICIT_LIFETIMES.short, declared.long ?? EXPLICIT_LIFETIMES.long),
		};
	if (mechanism === "key" && model.api === "openai-responses")
		return { mechanism, lifetimes: tiers(declared.short, declared.long ?? EXTENDED_KEY_LIFETIME) };
	return { mechanism, lifetimes: tiers(declared.short, declared.long) };
}

function cacheMechanism(model: Model<Api>, env?: ProviderEnv): CacheMechanism {
	switch (model.api) {
		case "anthropic-messages":
			return "markers";
		case "bedrock-converse-stream": {
			const bedrock = model as Model<"bedrock-converse-stream">;
			return isAnthropicClaudeModel(bedrock) && supportsPromptCaching(bedrock, env) ? "markers" : "implicit";
		}
		case "openai-completions":
			return getCompletionsCompat(model as Model<"openai-completions">).cacheControlFormat === "anthropic"
				? "markers"
				: "key";
		case "openai-responses":
			return getResponsesCompat(model as Model<"openai-responses">).supportsExplicitPromptCacheMode
				? "explicit-breakpoint"
				: "key";
		case "azure-openai-responses":
		case "openai-codex-responses":
		case "mistral-conversations":
			return "key";
		case "google-generative-ai":
		case "google-vertex":
			return "implicit";
		default:
			return "none";
	}
}

/** Whether the endpoint accepts the long tier; `compat.supportsLongCacheRetention: false` always rules it out. */
function supportsLongRetention(model: Model<Api>): boolean {
	switch (model.api) {
		case "anthropic-messages":
			return getAnthropicCompat(model as Model<"anthropic-messages">).supportsLongCacheRetention;
		case "openai-responses":
			return getResponsesCompat(model as Model<"openai-responses">).supportsLongCacheRetention;
		case "openai-completions":
			return getCompletionsCompat(model as Model<"openai-completions">).supportsLongCacheRetention;
		default:
			return (
				(model.compat as { supportsLongCacheRetention?: boolean } | undefined)?.supportsLongCacheRetention !== false
			);
	}
}
