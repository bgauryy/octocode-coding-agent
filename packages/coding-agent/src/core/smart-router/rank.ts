import type { Candidate, CapabilityTier, ModelStatistics, SmartRouterOptions } from "./types.ts";

/** Output tokens assumed when pricing a request without observed cost. */
const EXPECTED_OUTPUT_TOKENS = 1500;
/** Samples before a success rate counts. */
const MIN_SAMPLES = 5;
const UNRELIABLE_BELOW = 0.8;

/** USD estimate for one request. A flat-rate plan costs nothing per request. */
function requestCost(candidate: Candidate, inputTokens: number, stats: ModelStatistics | undefined): number {
	if (candidate.billing === "plan") return 0;
	if (stats?.costPerRequestUsd !== undefined && stats.costPerRequestUsd >= 0) return stats.costPerRequestUsd;
	const { input, output } = candidate.model.cost;
	return (inputTokens * input + EXPECTED_OUTPUT_TOKENS * output) / 1_000_000;
}

function unreliable(stats: ModelStatistics | undefined): boolean {
	return (
		stats?.successRate !== undefined && (stats.samples ?? 0) >= MIN_SAMPLES && stats.successRate < UNRELIABLE_BELOW
	);
}

/**
 * Order candidates best first, deterministically. Models that meet `required` come first, cheapest first
 * (a plan costs nothing), with reliable ones ahead of unreliable ones; the rest follow, strongest first.
 * Ties break on higher tier, known latency, then key.
 */
export function rankCandidates(
	candidates: readonly Candidate[],
	required: CapabilityTier,
	inputTokens: number,
	options: Pick<SmartRouterOptions, "statistics">,
): Candidate[] {
	const scored = candidates.map((candidate) => {
		const stats = options.statistics?.(candidate.model);
		return {
			candidate,
			meets: candidate.tier >= required,
			bad: unreliable(stats),
			cost: requestCost(candidate, inputTokens, stats),
			latency: stats?.medianLatencyMs ?? Number.POSITIVE_INFINITY,
		};
	});
	scored.sort((a, b) => {
		if (a.meets !== b.meets) return a.meets ? -1 : 1;
		if (!a.meets && a.candidate.tier !== b.candidate.tier) return b.candidate.tier - a.candidate.tier;
		if (a.bad !== b.bad) return a.bad ? 1 : -1;
		if (a.cost !== b.cost) return a.cost - b.cost;
		if (a.candidate.tier !== b.candidate.tier) return b.candidate.tier - a.candidate.tier;
		if (a.latency !== b.latency) return a.latency - b.latency;
		return a.candidate.key < b.candidate.key ? -1 : a.candidate.key > b.candidate.key ? 1 : 0;
	});
	return scored.map((entry) => entry.candidate);
}
