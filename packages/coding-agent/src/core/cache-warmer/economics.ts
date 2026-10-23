import { type Api, calculateCost, type Model, type SimpleStreamOptions, type Usage } from "@octocodeai/octocode-ai";
import { resolveCacheRetention, resolveInstructionCacheRetention } from "@octocodeai/octocode-ai/utils/cache-policy";
import type { SessionEntry } from "../session-manager.ts";

/** Streaming warming never continues past this long after the real request that started it. */
export const MAX_WARMING_AGE_MS = 60 * 60_000;
/** Idle warming uses a shorter horizon because continuation estimates become less reliable with age. */
export const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
/** A refresh is sent only when it is expected to save at least this many dollars. */
export const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05;
/**
 * Chance that a real request arrives before the cache entry expires while the
 * agent sits idle. Measured from our own usage; per-session estimates were not
 * better than this constant.
 */
export const IDLE_CONTINUATION_PROBABILITY = 0.15;

/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
	if (!Number.isFinite(ttlMs) || ttlMs <= 10_000) return undefined;
	return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)));
}

/**
 * Lifetime of the prompt cache entry a request writes, from the model's
 * `promptCache` tier for the retention the request used. Undefined when the
 * model has no lifetime for that tier or caching is off.
 */
export function getPromptCacheTtlMs(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
	const retention = resolveCacheRetention(options?.cacheRetention, options?.env);
	if (retention === "none") return undefined;
	const instructions = resolveInstructionCacheRetention(options);
	// Whole-prompt warming economics cannot estimate a miss across separate lifetimes.
	if (instructions !== undefined && instructions !== retention) return undefined;
	const seconds = model.promptCache?.[retention];
	return seconds === undefined || !Number.isFinite(seconds) || seconds <= 0 ? undefined : seconds * 1000;
}

/**
 * Whether replaying the request with a one-token output cap leaves its cache
 * entry untouched. Anthropic's budget-based thinking (Claude models without
 * adaptive thinking) derives `budget_tokens` from `max_tokens`; the replay
 * would get a different budget, which Anthropic keys the message cache on,
 * and the model could still think for thousands of tokens.
 */
export function isReplayable(model: Model<Api>, options: SimpleStreamOptions | undefined): boolean {
	if (!options?.reasoning) return true;
	// Bedrock can expand the output cap to accommodate reasoning; do not price that as a one-token replay.
	if (model.api === "bedrock-converse-stream") return false;
	if (model.api !== "anthropic-messages") return true;
	return (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking === true;
}

/** Reported reusable prefix and uncached tail of the latest real request. */
export function lastPromptTokens(entries: SessionEntry[]): { cached: number; input: number } {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			return { cached: usage.cacheRead + usage.cacheWrite, input: usage.input };
		}
	}
	return { cached: 0, input: 0 };
}

export function price(
	model: Model<Api>,
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">>,
): number {
	const usage: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	};
	return calculateCost(model, usage).total;
}
