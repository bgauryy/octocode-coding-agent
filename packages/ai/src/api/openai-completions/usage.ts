import { calculateCost } from "../../models/model-helpers.ts";
import type { AssistantMessage, Model } from "../../types.ts";
import { createUsage } from "../../utils/assistant-message.ts";

/**
 * Usage from a Chat Completions usage chunk, priced. `longCacheWrites`: every cache marker the request carried was a 1h
 * marker (`applyAnthropicCacheControl`), so the writes are 1h writes; the endpoint (OpenRouter) reports one write count
 * with no split by lifetime, as the Anthropic adapter's `longCache` handles a reply without `cache_creation`.
 */
export function parseChunkUsage(
	rawUsage: {
		prompt_tokens?: number;
		completion_tokens?: number;
		cached_tokens?: number;
		prompt_cache_hit_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	},
	model: Model<"openai-completions">,
	longCacheWrites = false,
): AssistantMessage["usage"] {
	const promptTokens = rawUsage.prompt_tokens ?? 0;
	const cacheReadTokens =
		rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? rawUsage.cached_tokens ?? 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens ?? 0;

	// Follow documented OpenAI/OpenRouter semantics: cached_tokens is cache-read
	// tokens (hits). Providers disagree on placement: OpenAI/OpenRouter use
	// prompt_tokens_details.cached_tokens, DeepSeek uses prompt_cache_hit_tokens,
	// and Kimi documents top-level usage.cached_tokens on the final usage chunk.
	// OpenAI does not document or emit cache_write_tokens, but
	// OpenRouter-compatible providers can include it as a separate write count.
	// OpenRouter's own provider/tests affirm the separate mapping:
	// https://github.com/OpenRouterTeam/ai-sdk-provider/pull/409
	// Do not subtract writes from cached_tokens, otherwise spec-compliant
	// providers are under-reported. DS4 mirrors this contract too:
	// https://github.com/antirez/ds4/pull/29
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	// OpenAI completion_tokens already includes reasoning_tokens.
	const outputTokens = rawUsage.completion_tokens ?? 0;
	const usage = createUsage({
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens ?? 0,
	});
	if (longCacheWrites && cacheWriteTokens > 0) usage.cacheWrite1h = cacheWriteTokens;
	calculateCost(model, usage);
	return usage;
}
