import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import type { StreamOptions, Usage } from "../../types.ts";

export interface OpenAIResponsesStreamOptions {
	onProviderStreamEvent?: StreamOptions["onProviderStreamEvent"];
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	/** Explicit boundary on the leading instructions only; the calling adapter checks support. */
	instructionCacheTtl?: "30m" | "12h";
	/**
	 * Leave `ttl` out of every breakpoint, so it inherits the request TTL (`prompt_cache_options.ttl`, default 30m); for
	 * endpoints that document the breakpoint as `{ mode: "explicit" }` only (Azure).
	 */
	omitBreakpointTtl?: boolean;
	/** First section of the leading prompt that starts a second explicit block; needs `instructionCacheTtl`. */
	instructionCacheBoundary?: string;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	/** Whether later system messages are sent in place; otherwise they are folded into the leading prompt. */
	supportsMidConvoSystemMessages?: boolean;
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
	toolOptions?: ConvertResponsesToolsOptions;
	/**
	 * Effort for the reply being generated. When set, the thinking level is sent as
	 * configuration_update items instead of a changing reasoning.effort, which would invalidate the
	 * prompt cache. Each item sets the effort from that point on: one goes before every earlier
	 * reply with the level recorded on it (`providerThinkingLevel`), and one with this effort goes
	 * at the end. Earlier input therefore never changes. OpenAI documents the item before user
	 * messages only. After tool results it was verified on gpt-6-luna (October 2026) to be accepted
	 * and to apply to the next reply.
	 */
	configurationUpdateEffort?: string;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	toolSearchResult?: boolean;
}
