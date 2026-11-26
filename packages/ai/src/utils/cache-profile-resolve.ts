import type { Model, OpenAIResponsesCompat } from "../types.ts";
import { getCompat as getCompletionsCompat } from "../api/openai-completions/compat.ts";
import { profileCacheFacts } from "./provider-profile.ts";
import { CACHE_PROFILES, type CacheProfile } from "./cache-profiles.ts";

/**
 * The cache profile of an OpenAI Chat Completions model. Anthropic-format hosts take markers; others cache by prefix and
 * key. The key rule: `api.openai.com` takes the key whenever caching is on, a host or model whose compat allows long
 * retention takes it with long retention, any other host none (and then caches only what the host does by itself).
 */
export function completionsCacheProfile(model: Model<"openai-completions">): CacheProfile {
	// Bedrock's OpenAI-compatible endpoints (runtime `/openai/v1`, mantle): AWS documents `prompt_cache_key` and explicit
	// caching for OpenAI models only; every other model (Qwen, Kimi, GLM, ...) is cached, if at all, by the host with no
	// request field, so none is sent.
	const facts = profileCacheFacts(model);
	if (facts.explicitCacheModelPrefix !== undefined && !model.id.startsWith(facts.explicitCacheModelPrefix))
		return CACHE_PROFILES.implicit;
	const compat = getCompletionsCompat(model);
	const key = facts.keyWhenCached ? "cached" : compat.supportsLongCacheRetention ? "long" : "never";
	const base = compat.cacheControlFormat === "anthropic" ? CACHE_PROFILES.completionsMarkers : CACHE_PROFILES.openaiKey;
	return { ...base, key };
}

/**
 * The cache profile of an OpenAI Responses request: explicit breakpoints where the compat opts into explicit mode, 30m
 * instruction breakpoints where it only supports those (Azure GPT-6 Astra), else key routing.
 */
export function responsesCacheProfile(
	compat: Pick<OpenAIResponsesCompat, "supportsExplicitPromptCacheMode"> &
		Partial<Pick<OpenAIResponsesCompat, "supportsInstructionBreakpoints">>,
): CacheProfile {
	if (compat.supportsExplicitPromptCacheMode) return CACHE_PROFILES.openaiExplicit;
	return compat.supportsInstructionBreakpoints ? CACHE_PROFILES.azureInstructionBreakpoints : CACHE_PROFILES.openaiKey;
}
