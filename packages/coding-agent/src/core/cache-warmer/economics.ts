import {
	type Api,
	calculateCost,
	type Context,
	getCurrentSystemMessage,
	getSystemMessageText,
	type Model,
	normalizeContext,
	resolveModelCapabilities,
	type SimpleStreamOptions,
	type Usage,
} from "@octocodeai/octocode-ai";
import { createEmptyUsage } from "@octocodeai/octocode-ai/utils/assistant-message";
import { resolveCacheRetention, resolveInstructionCacheRetention } from "@octocodeai/octocode-ai/utils/cache-policy";
import { charsToTokens } from "@octocodeai/octocode-ai/utils/estimate";
import type { SessionEntry } from "../session-manager.ts";

/** Streaming warming never continues past this long after the real request that started it. */
export const MAX_WARMING_AGE_MS = 60 * 60_000;
/** Idle warming uses a shorter horizon because continuation estimates become less reliable with age. */
const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000;
/**
 * How long after its start an idle run may still refresh: the idle horizon, or one lifetime when the entry lives longer,
 * so a one-hour entry gets the one refresh that falls at 90% of its lifetime instead of none.
 */
export function idleWarmingLimitMs(ttlMs: number): number {
	return Math.max(MAX_IDLE_WARMING_AGE_MS, ttlMs);
}
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

const validSeconds = (seconds: number | undefined): seconds is number =>
	seconds !== undefined && Number.isFinite(seconds) && seconds > 0;

interface PromptCacheLifetime {
	/** Lifetime of the shortest-lived entry the request writes: the history entry. */
	ttlMs: number;
	/**
	 * True when the instructions are written with a longer lifetime than the history. When the history entry
	 * expires, the instruction prefix is still read from its own entry, so only the history is rewritten.
	 */
	layered: boolean;
}

/**
 * Lifetimes of the prompt cache entries a request writes, for the retention pair the request used: the model's resolved
 * cache tiers (`resolveModelCapabilities`), which take a declared `promptCache` lifetime first and otherwise the lifetime
 * the adapter sends, and have no long tier where the adapter sends none (a marker adapter then sends long history at the
 * short lifetime). Undefined when the model has no lifetime for that tier or caching is off.
 */
export function getPromptCacheLifetime(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): PromptCacheLifetime | undefined {
	const retention = resolveCacheRetention(options?.cacheRetention, options?.env);
	if (retention === "none") return undefined;
	const instructions = resolveInstructionCacheRetention(options);
	// Adapters with Anthropic-style markers send long history behind short instructions at the short lifetime; that is
	// the safe lifetime to plan with for any provider.
	const { mechanism, lifetimes } = resolveModelCapabilities(model, options?.env).cache;
	// A marker adapter also sends long history at the short lifetime where the endpoint has no long tier.
	const history =
		(instructions === "short" && retention === "long") || (mechanism === "markers" && lifetimes.long === undefined)
			? "short"
			: retention;
	const seconds = lifetimes[history];
	if (!validSeconds(seconds)) return undefined;
	const layered =
		instructions === "long" && history === "short" && validSeconds(lifetimes.long) && lifetimes.long > seconds;
	return { ttlMs: seconds * 1000, layered };
}

/** Lifetime of the history entry, the first one a request's cache loses. See {@link getPromptCacheLifetime}. */
export function getPromptCacheTtlMs(model: Model<Api>, options: SimpleStreamOptions | undefined): number | undefined {
	return getPromptCacheLifetime(model, options)?.ttlMs;
}

/**
 * Upper-bound token estimate of the instruction prefix (current system prompt and tool declarations) that an
 * instruction cache breakpoint covers. Over-estimating it under-estimates the history a miss would rewrite, so
 * layered warming errs toward not refreshing.
 */
export function estimateInstructionPrefixTokens(context: Context): number {
	const system = getCurrentSystemMessage(normalizeContext(context).messages);
	if (!system) return 0;
	return charsToTokens(
		getSystemMessageText(system).length + (system.toolsAdded?.length ? JSON.stringify(system.toolsAdded).length : 0),
	);
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
	tokens: Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h">>,
): number {
	const usage: Usage = { ...createEmptyUsage(), ...tokens };
	return calculateCost(model, usage).total;
}
