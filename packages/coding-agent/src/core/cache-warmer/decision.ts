import { activeRates, type Usage } from "@octocodeai/octocode-ai";
import { CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS, price } from "./economics.ts";
import type { ActiveRun, CacheWarmingDecision } from "./types.ts";

type Tokens = Partial<Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "cacheWrite12h">>;

function sum(...parts: Tokens[]): Tokens {
	const total: Tokens = {};
	for (const part of parts)
		for (const [key, value] of Object.entries(part) as [keyof Tokens, number][]) total[key] = (total[key] ?? 0) + value;
	return total;
}

/** The latest real request's size, `lastPromptTokens`: its cached prefix and its uncached tail. */
export interface PromptSize {
	cached: number;
	input: number;
}

/**
 * Prices one refresh against the miss it prevents. Each price is a whole request's, never a slice's, so a context-size
 * price tier (`calculateCost`) is picked by the full prompt: the next real request carries at least the replayed one.
 *
 *     hit  = read(cached) + tail                 the next request after a refresh
 *     miss = read(instructions) + rewrite(expiring history) + tail
 *     warm = hit + the one-token reply           missCost = miss − hit
 *
 * With layered lifetimes the instruction prefix is still read from its own longer entry, so only the history expires. A
 * miss rewrites the history at the tier the request wrote it at (`getPromptCacheLifetime`), at the input price where the
 * model lists no write rate. The uncached tail goes out the same way in each request, so it changes only the tier.
 */
export function warmingDecision(
	run: Pick<ActiveRun, "model" | "phase" | "ttlMs" | "historyTier" | "instructionTokens">,
	prompt: PromptSize,
	outputTokens: number,
	continuationProbability: number,
): CacheWarmingDecision {
	const { model } = run;
	const rates = activeRates(model.cost);
	const expiring = Math.max(0, prompt.cached - run.instructionTokens);
	const tail: Tokens = rates.cacheWrite > rates.input ? { cacheWrite: prompt.input } : { input: prompt.input };
	const longField = run.ttlMs >= 12 * 3_600_000 ? "cacheWrite12h" : "cacheWrite1h";
	const rewrite: Tokens =
		rates.cacheWrite <= 0
			? { input: expiring }
			: run.historyTier === "long"
				? { cacheWrite: expiring, [longField]: expiring }
				: { cacheWrite: expiring };
	const hit = sum({ cacheRead: prompt.cached }, tail);
	const hitCost = price(model, hit);
	const missCost = Math.max(0, price(model, sum({ cacheRead: prompt.cached - expiring }, rewrite, tail)) - hitCost);
	const warmCost = price(model, sum(hit, { output: outputTokens }));
	// Pricing is known when either rate applies; a layered prompt with no expiring history still has known economics.
	const economicsAvailable =
		prompt.cached > 0 &&
		(price(model, { cacheRead: prompt.cached }) > 0 ||
			price(model, rates.cacheWrite > 0 ? { cacheWrite: prompt.cached } : { input: prompt.cached }) > 0);
	const expectedSavings = continuationProbability * missCost - warmCost;
	return {
		phase: run.phase,
		warmCost,
		missCost,
		continuationProbability,
		expectedSavings,
		economicsAvailable,
		action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
	};
}
