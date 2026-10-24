import type { CacheRetention, OpenAIResponsesCompat, StreamOptions } from "../types.ts";
import { resolveCacheRetention, resolveInstructionCacheRetention } from "../utils/cache-policy.ts";

// OpenAI prompt caching fields, verified 2026-10-24 against
// https://developers.openai.com/api/docs/guides/prompt-caching
// GPT-5.6 and later take prompt_cache_options and per-block prompt_cache_breakpoint (Responses API only);
// earlier models take prompt_cache_retention. prompt_cache_key routes requests before GPT-5.6 and only
// separates accounting from GPT-5.6 on.

const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

export type OpenAIPromptCacheTtl = "30m" | "12h";

export interface OpenAIResponsesCacheFields {
	prompt_cache_key?: string;
	prompt_cache_retention?: "24h";
	prompt_cache_options?: { mode?: "implicit" | "explicit"; ttl?: OpenAIPromptCacheTtl };
	/** TTL of the explicit breakpoints on the leading developer message, or undefined for none. */
	instructionCacheTtl?: OpenAIPromptCacheTtl;
}

type CacheCompat = Pick<
	Required<OpenAIResponsesCompat>,
	"supportsExplicitPromptCacheMode" | "supportsLongCacheRetention"
>;

function toTtl(retention: CacheRetention, compat: CacheCompat): OpenAIPromptCacheTtl {
	return retention === "long" && compat.supportsLongCacheRetention ? "12h" : "30m";
}

/**
 * Cache fields for one Responses request. `omitUnsupportedFields` drops everything but the key, for
 * credentials that reject the API cache parameters (Sign in with ChatGPT).
 *
 * Explicit-mode models: `none` selects explicit mode with no breakpoints (no caching, no writes); long history
 * sets the request TTL, which also covers the implicit breakpoint; instructions get their own explicit
 * breakpoints. A 12h breakpoint may follow a 30m one, and at most three of the four write slots are used
 * (two instruction blocks and the implicit breakpoint). Earlier models only take a request-level retention.
 */
export function resolveOpenAIResponsesCacheFields(
	compat: CacheCompat,
	options: Pick<StreamOptions, "cacheRetention" | "instructionCacheRetention" | "sessionId" | "env"> | undefined,
	omitUnsupportedFields: boolean,
): OpenAIResponsesCacheFields {
	const history = resolveCacheRetention(options?.cacheRetention, options?.env);
	const fields: OpenAIResponsesCacheFields = {
		prompt_cache_key: history === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
	};
	if (omitUnsupportedFields) return fields;
	if (!compat.supportsExplicitPromptCacheMode) {
		if (history === "long" && compat.supportsLongCacheRetention) fields.prompt_cache_retention = "24h";
		return fields;
	}
	if (history === "none") {
		fields.prompt_cache_options = { mode: "explicit" };
		return fields;
	}
	if (toTtl(history, compat) === "12h") fields.prompt_cache_options = { ttl: "12h" };
	const instructions = resolveInstructionCacheRetention(options);
	if (instructions !== undefined && instructions !== "none") fields.instructionCacheTtl = toTtl(instructions, compat);
	return fields;
}
