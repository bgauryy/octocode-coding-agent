import type { ModelCost } from "@octocodeai/octocode-ai";

/**
 * Whether compacting at a finished backlog item pays. A compaction frees the history beyond what it keeps; every later
 * request then reads fewer tokens. It costs one summary request (which reads the whole context), the summary itself and,
 * on a caching provider, a cache write of what is kept. Prices are per million tokens; a price a model does not state
 * (0 or missing) follows a fixed ratio to its input price, itself 1 when not stated.
 */

/** Cached reads, cache writes and output relative to the input price, for models that state none. */
const FALLBACK_RATIO = { cacheRead: 0.1, cacheWrite: 1.25, output: 5 } as const;
/** The most requests a compaction is credited with saving: later ones are less certain to still need the history. */
const MAX_EXPECTED_REQUESTS = 50;
/** The largest summary the estimate assumes, in tokens; a short history gets a tenth of itself. */
const SUMMARY_TOKENS_MAX = 4_000;

type Cost = Partial<Pick<ModelCost, "input" | "output" | "cacheRead" | "cacheWrite">> | undefined;

interface Prices {
	input: number;
	read: number;
	write: number;
	output: number;
}

function priced(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function pricesOf(cost: Cost, cached: boolean): Prices {
	const input = priced(cost?.input, 1);
	return {
		input,
		read: cached ? priced(cost?.cacheRead, input * FALLBACK_RATIO.cacheRead) : input,
		write: cached ? priced(cost?.cacheWrite, input * FALLBACK_RATIO.cacheWrite) : 0,
		output: priced(cost?.output, input * FALLBACK_RATIO.output),
	};
}

export interface DoneGainInput {
	/** The context the next request sends. */
	tokens: number;
	/** The system prompt and tool declarations in it: no compaction frees them. */
	fixedTokens: number;
	/** What a compaction keeps of the recent history. */
	keepTokens: number;
	/** Whether the provider reads this session's prefix from a cache. */
	cached: boolean;
	cost: Cost;
	/** Requests the session is expected to make while the freed history would have been read. */
	expectedRequests: number;
}

export interface DoneGain {
	historyTokens: number;
	freed: number;
	/** In price units (USD per million tokens when the model states them). */
	estCost: number;
	/** What one later request saves. */
	estSaving: number;
	pays: boolean;
}

export function doneGain(input: DoneGainInput): DoneGain {
	const historyTokens = Math.max(0, input.tokens - input.fixedTokens);
	const kept = Math.min(input.keepTokens, historyTokens);
	const freed = historyTokens - kept;
	const summary = Math.min(SUMMARY_TOKENS_MAX, Math.floor(historyTokens / 10));
	const price = pricesOf(input.cost, input.cached);
	const estCost = input.tokens * price.read + summary * price.output + (kept + summary) * price.write;
	const estSaving = freed * price.read;
	return { historyTokens, freed, estCost, estSaving, pays: estSaving * input.expectedRequests > estCost };
}

/** Requests until the session's own open items are done: its average per finished item times the items left, bounded. */
export function expectedRequests(averagePerItem: number, remaining: number): number {
	if (remaining <= 0) return 0;
	return Math.min(MAX_EXPECTED_REQUESTS, Math.max(1, Math.ceil(averagePerItem * remaining)));
}

/** Finished items needed before the session's own average is trusted over `DEFAULT_REQUESTS_PER_ITEM`. */
export const MIN_ITEM_SAMPLE = 3;
/** Requests per item assumed until enough items are measured: a conservative figure, below what a long first item shows. */
export const DEFAULT_REQUESTS_PER_ITEM = 3;

/** Requests per finished item from the turns each took; the default while fewer than `MIN_ITEM_SAMPLE` are known. */
export function averageRequestsPerItem(perItem: readonly number[]): number {
	if (perItem.length < MIN_ITEM_SAMPLE) return DEFAULT_REQUESTS_PER_ITEM;
	return perItem.reduce((sum, count) => sum + count, 0) / perItem.length;
}
