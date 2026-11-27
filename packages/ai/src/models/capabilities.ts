/**
 * One normalized view of what a model accepts and how its requests are shaped: limits, input modalities, thinking
 * control and cache mechanism. Adapters, the application and its UI read capabilities from here instead of deriving
 * them again from API names, provider names or model IDs.
 */
import { getAnthropicCompat } from "../api/anthropic-messages/compat.ts";
import {
	bedrockSupportsLongCacheRetention,
	supportsPromptCaching,
} from "../api/bedrock-converse-stream/model-match.ts";
import {
	azureSupportsExplicitPromptCacheMode,
	azureSupportsInstructionBreakpoints,
	azureSupportsLongCacheRetention,
} from "../api/azure-openai-config.ts";
import { completionsCacheProfile } from "../utils/cache-profile-resolve.ts";
import type { PromptCacheKeyRule } from "../utils/cache-profiles.ts";
import { getCompat as getCompletionsCompat } from "../api/openai-completions/compat.ts";
import { getCompat as getResponsesCompat } from "../api/openai-responses/compat.ts";
import type { Api, Model, ModelThinkingLevel, ProviderEnv } from "../types.ts";
import { profileCacheFacts } from "../utils/provider-profile.ts";
import { resolveModelThinking, thinkingControl, type ThinkingControl } from "./thinking.ts";

export type { ThinkingControl } from "./thinking.ts";

/**
 * How a prompt prefix is cached: `markers` are Anthropic-style breakpoints with 5-minute and 1-hour tiers, `key` is a
 * routing key with provider-managed retention, `explicit-breakpoint` is OpenAI's explicit cache mode (on Azure, a
 * deployment that opted in with `compat.supportsExplicitPromptCacheMode`, or GPT-6 Astra's 30m instruction breakpoints
 * beside a routing key), `implicit` is provider-managed caching with nothing
 * to send, `none` caches nothing.
 */
export type CacheMechanism = "markers" | "key" | "explicit-breakpoint" | "implicit" | "none";

export interface ModelCapabilities {
	/** The model's capacity in tokens; a session's working budget is applied separately. */
	contextWindow: number;
	maxOutputTokens: number;
	maxInputTokens?: number;
	input: Model<Api>["input"];
	thinking: { control: ThinkingControl; levels: ModelThinkingLevel[]; canDisable: boolean };
	cache: {
		mechanism: CacheMechanism;
		/** Lifetimes to plan with, in seconds; `long` is the typical lifetime where it is shorter than `longUpTo`. */
		lifetimes: { short?: number; long?: number };
		/**
		 * The longest a long entry may live, where the provider keeps it a typical time shorter than that (OpenAI and Azure
		 * `24h` extended retention: "typically ... around 30 minutes", up to 24 hours). Absent where `long` is exact.
		 */
		longUpTo?: number;
		/**
		 * Set where the long tier exists only for the instruction breakpoints, so long history retention keeps the history
		 * at the short lifetime: OpenAI explicit mode keeps the request TTL, which covers the history, at 30 minutes.
		 */
		longInstructionsOnly?: true;
		/** Chat Completions only: when the request carries `prompt_cache_key`. Absent where the adapter decides otherwise. */
		key?: PromptCacheKeyRule;
	};
}

/** Anthropic marker lifetimes in seconds: 5 minutes, and 1 hour where the endpoint accepts it. */
const MARKER_LIFETIMES = { short: 300, long: 3600 } as const;
/** OpenAI explicit cache mode lifetimes in seconds: 30 minutes and 12 hours. */
const EXPLICIT_LIFETIMES = { short: 1800, long: 43_200 } as const;
/**
 * OpenAI and Azure extended retention for implicit caching (`prompt_cache_retention: "24h"`), in seconds. OpenAI: it
 * "typically keeps entries available for around 30 minutes and can retain them for up to 24 hours"
 * (https://developers.openai.com/api/docs/guides/prompt-caching, 2026-11-19), so the warmer, compaction and clearing
 * plan with the typical lifetime and 24 hours stays the upper bound.
 */
const EXTENDED_KEY_LIFETIME = { typical: 1800, upTo: 86_400 } as const;

export function resolveModelCapabilities(model: Model<Api>, env?: ProviderEnv): ModelCapabilities {
	return {
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		...(model.inputLimits?.maxInputTokens !== undefined && model.inputLimits.maxInputTokens < model.contextWindow
			? { maxInputTokens: model.inputLimits.maxInputTokens }
			: {}),
		input: model.input,
		thinking: resolveModelThinking(model),
		cache: cacheCapability(model, env),
	};
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
	// The 24h tier, planned at its typical lifetime unless the model declares its own.
	const extended = (short: number | undefined) => ({
		lifetimes: tiers(short, declared.long ?? EXTENDED_KEY_LIFETIME.typical),
		...(long && declared.long === undefined ? { longUpTo: EXTENDED_KEY_LIFETIME.upTo } : {}),
	});
	if (mechanism === "markers")
		return {
			mechanism,
			lifetimes: tiers(declared.short ?? MARKER_LIFETIMES.short, declared.long ?? MARKER_LIFETIMES.long),
		};
	// Azure outside explicit mode: 30m instruction breakpoints in implicit mode (GPT-6 Astra), and 24h key retention
	// where it is accepted. A deployment opted in to explicit mode takes OpenAI's 30m and 12h tiers below.
	if (model.api === "azure-openai-responses" && !azureSupportsExplicitPromptCacheMode(model)) {
		const short = mechanism === "explicit-breakpoint" ? (declared.short ?? EXPLICIT_LIFETIMES.short) : declared.short;
		return { mechanism, ...extended(short) };
	}
	if (mechanism === "explicit-breakpoint")
		return {
			mechanism,
			lifetimes: tiers(declared.short ?? EXPLICIT_LIFETIMES.short, declared.long ?? EXPLICIT_LIFETIMES.long),
			// Azure breakpoints take no `ttl`, so its request TTL (the history's) carries the long tier there.
			...(model.api === "azure-openai-responses" || !long ? {} : { longInstructionsOnly: true as const }),
		};
	if (mechanism === "key" && model.api === "openai-responses") return { mechanism, ...extended(declared.short) };
	if (model.api === "openai-completions" && mechanism === "key")
		return {
			mechanism,
			lifetimes: tiers(declared.short, declared.long),
			key: completionsCacheProfile(model as Model<"openai-completions">).key,
		};
	return { mechanism, lifetimes: tiers(declared.short, declared.long) };
}

/**
 * APIs whose reasoning setting does not depend on the output cap, so a one-token replay keeps the original's cache key.
 * Google sends a thinking level or a fixed per-family budget, so its replay differs only in `maxOutputTokens`.
 */
const REPLAY_STABLE_APIS: ReadonlySet<Api> = new Set<Api>([
	"openai-responses",
	"azure-openai-responses",
	"openai-completions",
	"mistral-conversations",
	"google-generative-ai",
	"google-vertex",
]);

/**
 * Whether a one-token replay of a request that asks for reasoning leaves its cache entry untouched. False where the
 * reasoning budget derives from the output cap (Anthropic budget thinking, Bedrock) and for an API this table does
 * not know: the replay would differ from the original, so it is not priced as one.
 */
export function replaysWithReasoningUnchanged(model: Model<Api>): boolean {
	if (model.api === "anthropic-messages") return thinkingControl(model) !== "budget";
	return REPLAY_STABLE_APIS.has(model.api);
}

/**
 * A gateway that serves every upstream on its Anthropic-compatible endpoint (Vercel AI Gateway) has Anthropic's cache
 * entries only for Anthropic's ids: an OpenAI, Google or other upstream caches on its own terms. The profile's
 * `anthropicIdPrefix` names those ids; a model declaring the `anthropic` profile has none and always takes markers.
 */
function servesNonAnthropicUpstream(model: Model<Api>): boolean {
	const prefix = profileCacheFacts(model, "any").anthropicIdPrefix;
	return prefix !== undefined && !model.id.toLowerCase().startsWith(prefix);
}

function cacheMechanism(model: Model<Api>, env?: ProviderEnv): CacheMechanism {
	switch (model.api) {
		case "anthropic-messages":
			return servesNonAnthropicUpstream(model) ? "implicit" : "markers";
		case "bedrock-converse-stream": {
			const bedrock = model as Model<"bedrock-converse-stream">;
			return supportsPromptCaching(bedrock, env) ? "markers" : "implicit";
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
			return azureSupportsExplicitPromptCacheMode(model) || azureSupportsInstructionBreakpoints(model)
				? "explicit-breakpoint"
				: "key";
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
		case "bedrock-converse-stream":
			return bedrockSupportsLongCacheRetention(model as Model<"bedrock-converse-stream">);
		case "azure-openai-responses":
			return azureSupportsLongCacheRetention(model);
		default:
			return (
				(model.compat as { supportsLongCacheRetention?: boolean } | undefined)?.supportsLongCacheRetention !== false
			);
	}
}
