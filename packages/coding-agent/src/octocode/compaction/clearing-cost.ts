import { activeRates, type Api, type Model } from "@octocodeai/octocode-ai";
import { price } from "../../core/cache-warmer/economics.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

/**
 * When clearing old tool results pays for itself while the prompt cache is still warm (`clearing.ts`).
 *
 * Clearing replaces old results with short placeholders. The request after it cannot read the cached history from the
 * first cleared result on, so it writes that part again once; every request after that re-sends the cleared results'
 * tokens no more. So, with
 *
 * | Input     | Meaning                                                                                                   |
 * | --------- | --------------------------------------------------------------------------------------------------------- |
 * | `T_old`   | tokens of the results that would be cleared                                                               |
 * | `S_after` | tokens from the first cleared result to the end of the context, after clearing (placeholders included)   |
 * | `R`       | price of one cached token read                                                                            |
 * | `W`       | price of one token written to the cache at the session's lifetime (the input price where writes cost no premium) |
 * | `N`       | requests expected to re-send the old results (`expectedRemainingRequests`)                                |
 *
 * clearing pays when the re-send cost it saves exceeds the one-time write it causes:
 *
 *     T_old × R × N  >  S_after × W
 *
 * A request that rewrites the cache anyway (the cache went cold, the model changed, a system update folds into the leading
 * prompt) pays that write regardless, so there the extra cost is zero and clearing always pays.
 *
 * Without catalog prices (a local or unpriced model) the ratios are Anthropic's: a read costs `DEFAULT_READ_RATIO` and a
 * write `DEFAULT_SHORT_WRITE_RATIO` (5-minute lifetime) or `DEFAULT_LONG_WRITE_RATIO` (longer) of the input price.
 */

/** Cache-read price over the input price when the model lists none. */
export const DEFAULT_READ_RATIO = 0.1;
/** Cache-write price over the input price for a 5-minute entry when the model lists none. */
export const DEFAULT_SHORT_WRITE_RATIO = 1.25;
/** Cache-write price over the input price for a longer entry (1 hour and up) when the model lists none. */
export const DEFAULT_LONG_WRITE_RATIO = 2;
/** The longest lifetime written at the short-entry price. */
const SHORT_LIFETIME_MS = 5 * 60_000;

/** Price per token of a cache read and a cache write, in any one unit (only their ratio matters). */
export interface CachePrices {
	read: number;
	write: number;
}

/** The read and write price per token of `model` for an entry that lives `ttlMs`; Anthropic's ratios without catalog prices. */
export function cachePrices(model: Model<Api> | undefined, ttlMs: number): CachePrices {
	const long = ttlMs > SHORT_LIFETIME_MS;
	return (
		catalogPrices(model, ttlMs) ?? {
			read: DEFAULT_READ_RATIO,
			write: long ? DEFAULT_LONG_WRITE_RATIO : DEFAULT_SHORT_WRITE_RATIO,
		}
	);
}

/** The catalog's prices in US dollars per million tokens, or undefined when `model` lists none (`cachePrices` then uses ratios). */
export function catalogPrices(model: Model<Api> | undefined, ttlMs: number): CachePrices | undefined {
	if (!model?.cost) return undefined;
	const long = ttlMs > SHORT_LIFETIME_MS;
	const tokens = 1_000_000;
	const rates = activeRates(model.cost);
	const read = price(model, { cacheRead: tokens });
	const write = price(
		model,
		rates.cacheWrite > 0 ? { cacheWrite: tokens, ...(long ? { cacheWrite1h: tokens } : {}) } : { input: tokens },
	);
	return read > 0 && write > 0 ? { read, write } : undefined;
}

/**
 * Requests expected to re-send the context's old results: as many as the context has seen so far (`requests`: the
 * replies since it started or was last compacted, never the ones kept from before a compaction; a session that has run k requests is about as likely to run k more), capped by the
 * requests left before the context (`contextTokens`) fills `contextWindow` (the compaction threshold) at its average growth per request so far,
 * when a compaction summarizes the old results anyway. Growth counts from `startTokens`, the prompt the first of those
 * requests sent (the fixed prefix, and after a compaction its summary and kept tail), or from zero when it is unknown.
 */
export function expectedRemainingRequests(
	requests: number,
	contextTokens: number,
	contextWindow?: number,
	startTokens = 0,
): number {
	if (requests <= 0) return 0;
	if (contextWindow === undefined || contextWindow <= 0 || contextTokens <= 0) return requests;
	const growthPerRequest = (contextTokens - Math.min(startTokens, contextTokens)) / requests;
	if (growthPerRequest <= 0) return requests;
	return Math.max(0, Math.min(requests, (contextWindow - contextTokens) / growthPerRequest));
}

/** A session whose earlier clearings realized fewer requests than predicted expects this share of the prediction at least. */
const CALIBRATION_FLOOR = 0.25;

/**
 * How many of the requests predicted for this session's earlier clearings came (`remainingRequests` recorded beside each
 * on `branch`, against the replies between it and the compaction that ended its old results), as one ratio of the
 * totals; undefined until a compaction ended one. Never above 1: across sessions the realized count runs above the
 * prediction (median 1.4 times, 102 warm clearings measured on 2026-11-19), so a session is only held to the prediction
 * it fell short of, between `CALIBRATION_FLOOR` and 1. `clearing.ts` scales the next prediction by it.
 */
export function realizedRequestsRatio(branch: readonly unknown[], customType: string): number | undefined {
	let predicted = 0;
	let realized = 0;
	const open: Array<{ predicted: number; replies: number }> = [];
	for (const entry of branch) {
		if (!isRecord(entry)) continue;
		if (entry.type === "custom" && entry.customType === customType && isRecord(entry.data)) {
			const expected = entry.data.remainingRequests;
			if (typeof expected === "number" && expected > 0) open.push({ predicted: expected, replies: 0 });
		} else if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant") {
			for (const event of open) event.replies++;
		} else if (entry.type === "compaction") {
			for (const event of open.splice(0)) {
				predicted += event.predicted;
				realized += event.replies;
			}
		}
	}
	if (predicted <= 0) return undefined;
	return Math.min(1, Math.max(CALIBRATION_FLOOR, realized / predicted));
}

/** The inputs of `clearingPays`, in tokens and the prices of `cachePrices`. */
export interface ClearingCost {
	oldTokens: number;
	suffixTokensAfter: number;
	remainingRequests: number;
	prices: CachePrices;
	/** The request rewrites the cache anyway: clearing adds no write. */
	rewriteAnyway: boolean;
}

/** What clearing saves in the unit of `prices`: `T_old × R × N − S_after × W`, with no write when the cache is rewritten anyway. */
export function clearingSaving(cost: ClearingCost): number {
	const saved = cost.oldTokens * cost.prices.read * cost.remainingRequests;
	return cost.rewriteAnyway ? saved : saved - cost.suffixTokensAfter * cost.prices.write;
}

/** Whether clearing pays: `T_old × R × N > S_after × W`, or any saving when the cache is rewritten anyway. */
export function clearingPays(cost: ClearingCost): boolean {
	if (cost.oldTokens <= 0) return false;
	if (cost.rewriteAnyway) return true;
	return clearingSaving(cost) > 0;
}
