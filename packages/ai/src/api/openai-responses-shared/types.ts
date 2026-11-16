type ResponseServiceTier = "auto" | "default" | "fast" | "flex" | "priority" | "scale" | "ultrafast" | null;
import type { StreamOptions, Usage } from "../../types.ts";

export interface OpenAIResponsesStreamOptions {
	onProviderStreamEvent?: StreamOptions["onProviderStreamEvent"];
	serviceTier?: ResponseServiceTier;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	resolveServiceTier?: (
		responseServiceTier: ResponseServiceTier | undefined,
		requestServiceTier: ResponseServiceTier | undefined,
	) => ResponseServiceTier | undefined;
	applyServiceTierPricing?: (usage: Usage, serviceTier: ResponseServiceTier | undefined) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	/**
	 * Resolved `supportsDeveloperRole` of the calling adapter; the converter never reads `model.compat` itself. When
	 * false, or for a model without reasoning, instructions go out under the `system` role. Default: true.
	 */
	supportsDeveloperRole?: boolean;
	/** Explicit boundary on the leading instructions only; the calling adapter checks support. */
	instructionCacheTtl?: "30m" | "12h";
	/**
	 * Leave `ttl` out of every breakpoint, so it inherits the request TTL (`prompt_cache_options.ttl`, default 30m); for
	 * endpoints that document the breakpoint as `{ mode: "explicit" }` only (Azure).
	 */
	omitBreakpointTtl?: boolean;
	/** First section of the leading prompt that starts a second explicit block; needs `instructionCacheTtl`. */
	instructionCacheBoundary?: string;
	/** First section of the leading prompt that starts the trailing block without a breakpoint; needs `instructionCacheTtl`. */
	instructionVolatileBoundary?: string;
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
