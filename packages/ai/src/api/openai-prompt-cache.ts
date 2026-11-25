import type { CacheRetention, OpenAIResponsesCompat, StreamOptions } from "../types.ts";
import { CACHE_PROFILES } from "../utils/cache-profiles.ts";
import { responsesCacheProfile } from "../utils/cache-profile-resolve.ts";
import {
	resolveCacheRetention,
	resolveInstructionCacheRetention,
	resolvePromptCacheKey,
} from "../utils/cache-policy.ts";

// OpenAI prompt caching fields, verified 2026-11-19 against
// https://developers.openai.com/api/docs/guides/prompt-caching
// GPT-5.6 and later take prompt_cache_options and per-block prompt_cache_breakpoint (Responses API only);
// earlier models take prompt_cache_retention ("typically keeps entries available for around 30 minutes and can
// retain them for up to 24 hours", no write charge). prompt_cache_key routes requests before GPT-5.6 and only
// separates accounting from GPT-5.6 on; the caller chooses the key (`promptCacheKey`).

const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

type OpenAIPromptCacheTtl = "30m" | "12h";

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
	const { ttl } = CACHE_PROFILES.openaiExplicit;
	return retention === "long" && compat.supportsLongCacheRetention ? ttl.long : ttl.default;
}

/**
 * Cache fields for one Responses request. `omitUnsupportedFields` drops everything but the key, for
 * credentials that reject the API cache parameters (Sign in with ChatGPT).
 *
 * Explicit-mode models: `none` selects explicit mode with no breakpoints (no caching, no writes); instructions get
 * their own explicit breakpoints, each with its own `ttl` ("`prompt_cache_breakpoint.ttl` overrides the request
 * default for one breakpoint"), and at most three of the four write slots are used (two instruction blocks and the
 * implicit breakpoint). The request TTL "applies to the implicit breakpoint", so it stays at the default 30m: a 12h
 * request TTL would write every turn's new tail at 2.5x instead of 1.25x for a window idle gaps rarely reach, and 12h
 * is worth its price only on the instruction blocks that sessions share. `breakpointsCarryTtl` false (Azure, whose
 * breakpoints take no `ttl`) keeps the request TTL as the only lifetime, so long history still sets it.
 *
 * Earlier models only take a request-level retention, with no write charge: `24h` goes out when either layer is
 * long, since it is the only way to keep the instructions longer.
 */
export function resolveOpenAIResponsesCacheFields(
	compat: CacheCompat,
	options:
		| Pick<
				StreamOptions,
				"cacheRetention" | "instructionCacheRetention" | "keepInstructionCache" | "sessionId" | "promptCacheKey" | "env"
		  >
		| undefined,
	omitUnsupportedFields: boolean,
	breakpointsCarryTtl = true,
): OpenAIResponsesCacheFields {
	const history = resolveCacheRetention(options?.cacheRetention, options?.env);
	const profile = responsesCacheProfile(compat);
	// Unlike Chat Completions (`completionsCacheProfile` limits the key to api.openai.com and hosts that opt in), the
	// Responses API's own docs (OpenAI prompt caching guide, Azure prompt caching) define `prompt_cache_key`; other
	// Responses hosts accept OpenAI's request shape and their wire tests assert the field (see docs/prompt-caching.md).
	const fields: OpenAIResponsesCacheFields = {
		prompt_cache_key:
			history === "none" || profile.key === "never"
				? undefined
				: clampOpenAIPromptCacheKey(resolvePromptCacheKey(options)),
	};
	if (omitUnsupportedFields) return fields;
	const instructions = resolveInstructionCacheRetention(options);
	// Explicit mode only: Azure Astra's instruction breakpoints (azureInstructionBreakpoints) are set by the caller.
	if (profile !== CACHE_PROFILES.openaiExplicit) {
		const long = history === "long" || (history !== "none" && instructions === "long");
		if (long && compat.supportsLongCacheRetention && profile.extendedRetention)
			fields.prompt_cache_retention = profile.extendedRetention;
		return fields;
	}
	if (history === "none") {
		fields.prompt_cache_options = { mode: "explicit" };
		// Only `keepInstructionCache` leaves an instruction tier at history `none` (a summary over live instructions).
		if (instructions !== undefined && instructions !== "none") fields.instructionCacheTtl = toTtl(instructions, compat);
		return fields;
	}
	if (!breakpointsCarryTtl && toTtl(history, compat) === "12h") fields.prompt_cache_options = { ttl: "12h" };
	// Instructions that follow a long history (`cacheRetention: "long"` alone) carry the long tier themselves.
	const instructionTier = instructions ?? (breakpointsCarryTtl && history === "long" ? history : undefined);
	if (instructionTier !== undefined && instructionTier !== "none")
		fields.instructionCacheTtl = toTtl(instructionTier, compat);
	return fields;
}
