import { activeRates, type Api, type Model, type ProviderEnv, resolveModelCapabilities } from "@octocodeai/octocode-ai";
import { isCacheTtlControllable } from "@octocodeai/octocode-ai/utils/cache-policy";
import {
	CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS,
	getCacheWarmingDelayMs,
	idleContinuationProbability,
	idleWarmingLimitMs,
	price,
} from "./economics.ts";
import { formatTtl } from "./usage-record.ts";

/**
 * Retention by cost (RFC F6). With base input price `b`, write multipliers `w_short` and `w_long`, read multiplier `r`,
 * cached prefix `P` and new tokens per turn `D`:
 *
 * | Choice             | Cost                                                              |
 * | ------------------ | ----------------------------------------------------------------- |
 * | long TTL premium   | `(w_long − w_short) × D × b` per turn, `(w_long − w_short) × P × b` once |
 * | keep-alive refresh | `r × P × b` per refresh                                           |
 * | miss               | `(w_tier − r) × P × b`                                            |
 *
 * A reply gap shorter than the lifetime costs nothing. A longer one costs the refreshes the warmer would send (one per
 * 90% of the lifetime, while the idle warming limit lasts, and only when its expected saving at the role's idle
 * probability clears the warmer's minimum) and, past that limit or without refreshes, one miss. Only the tiers the
 * adapter resolved count, so a host without a long tier never gets a long price.
 */
export interface RetentionInput {
	model: Model<Api>;
	env?: ProviderEnv;
	/** Cached prefix tokens at the span start (`P`). */
	prefixTokens: number;
	/** New tokens per turn (`D`). */
	turnTokens: number;
	/** Reply gaps of one span, in milliseconds; the span has one more turn than gaps. */
	gapsMs: readonly number[];
	/** Agent role, for its idle probability (`idleContinuationProbability`). */
	role?: string;
}

export interface RetentionPlan {
	/**
	 * `short` or `long`: the cheaper tier for the span. `provider`: the provider manages retention (key routing or
	 * implicit caching, as on Gemini and xAI) and the adapter sends no long tier, so there is nothing to choose or refresh.
	 */
	choice: "short" | "long" | "provider";
	shortTtl?: string;
	longTtl?: string;
	/** Expected US dollars per span for each tier the adapter sends. */
	costs: { short?: number; long?: number };
}

interface TierPrices {
	ttlMs: number;
	miss: number;
	refresh: number;
}

/** Expected cost of one reply gap on a tier, refreshes and miss included. */
function gapCost(gapMs: number, tier: TierPrices, probability: number): number {
	if (gapMs <= tier.ttlMs) return 0;
	const delay = getCacheWarmingDelayMs(tier.ttlMs);
	const warms = delay !== undefined && probability * tier.miss - tier.refresh >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS;
	if (!warms || delay === undefined) return tier.miss;
	// Refreshes fall every `delay` until the idle limit; the entry then lives one lifetime past the last of them.
	const lastRefreshAt = Math.floor(idleWarmingLimitMs(tier.ttlMs) / delay) * delay;
	const refreshes = Math.floor(Math.min(gapMs, lastRefreshAt) / delay);
	return refreshes * tier.refresh + (gapMs > lastRefreshAt + tier.ttlMs ? tier.miss : 0);
}

/** The tier to write a span at, among those the adapter resolved for `input.model`. */
export function planRetention(input: RetentionInput): RetentionPlan {
	const { model, prefixTokens: prefix, turnTokens: turn } = input;
	const { mechanism, lifetimes } = resolveModelCapabilities(model, input.env).cache;
	const shortTtl = lifetimes.short !== undefined ? formatTtl(lifetimes.short) : undefined;
	const longTtl = lifetimes.long !== undefined ? formatTtl(lifetimes.long) : undefined;
	const named = { ...(shortTtl ? { shortTtl } : {}), ...(longTtl ? { longTtl } : {}) };
	if (lifetimes.long === undefined && (!isCacheTtlControllable(mechanism) || lifetimes.short === undefined))
		return { choice: "provider", ...named, costs: {} };

	const premium = activeRates(model.cost).cacheWrite > 0;
	const read = price(model, { cacheRead: prefix });
	const refresh = price(model, { cacheRead: prefix, output: 1 });
	const shortWrite = (tokens: number) => price(model, premium ? { cacheWrite: tokens } : { input: tokens });
	const longField = (lifetimes.long ?? 0) >= 12 * 3600 ? "cacheWrite12h" : "cacheWrite1h";
	const longWrite = (tokens: number) =>
		price(model, premium ? { cacheWrite: tokens, [longField]: tokens } : { input: tokens });
	const probability = idleContinuationProbability(input.role);
	const spanCost = (tier: TierPrices, extra: number) =>
		input.gapsMs.reduce((sum, gap) => sum + gapCost(gap, tier, probability), extra);

	const costs: RetentionPlan["costs"] = {};
	if (lifetimes.short !== undefined) {
		const write = shortWrite(prefix);
		costs.short = spanCost({ ttlMs: lifetimes.short * 1000, miss: Math.max(0, write - read), refresh }, 0);
	}
	if (lifetimes.long !== undefined) {
		const write = longWrite(prefix);
		const turns = input.gapsMs.length + 1;
		const premiumCost = write - shortWrite(prefix) + turns * (longWrite(turn) - shortWrite(turn));
		costs.long = spanCost(
			{ ttlMs: lifetimes.long * 1000, miss: Math.max(0, write - read), refresh },
			Math.max(0, premiumCost),
		);
	}
	const choice =
		costs.long !== undefined && (costs.short === undefined || costs.long <= costs.short) ? "long" : "short";
	return { choice, ...named, costs };
}
