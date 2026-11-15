import type { ProfileFinding } from "@octocodeai/octocode-contracts/profiler";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { CLEARED_RESULTS_TYPE } from "../shared/cleared-results.ts";
import { num, promptTokens, type Prepared } from "./entries.ts";
import type { Lane } from "./timeline.ts";

/** One clearing wave, with what the decision rested on (the cleared-results entry) and what the next request cost. */
interface Wave {
	/** Index (among the lane's requests) of the first request after the wave. */
	request: number;
	/** The wave ran because the request rewrote the cache anyway. */
	cold: boolean;
	/** Tokens the next request wrote, and how far its prompt shrank against the request before the wave. */
	written: number;
	shrink: number;
	/** Requests from the next one until the following compaction or the end of the lane. */
	requests: number;
	/** Dollars the wave saved less the cache write it caused; undefined without catalog prices. */
	net?: number;
	predictedWritten?: number;
}

const usd = (value: number) => `${value < 0 ? "−" : ""}$${Math.abs(value).toFixed(2)}`;
const thousands = (tokens: number) => `${(tokens / 1000).toFixed(1)}k`;

/**
 * The waves of one lane. An entry written before the decision's inputs were recorded still counts, with no net: only
 * what the transcript shows (the next request's write, the shrink, the requests left) is derived from the usage.
 */
function waves(prepared: Prepared): Wave[] {
	const found: Wave[] = [];
	const { entries, requests } = prepared;
	entries.forEach((entry, position) => {
		if (entry.type !== "custom" || entry.customType !== CLEARED_RESULTS_TYPE) return;
		const data = asRecord(entry.data);
		const after = requests.findIndex((at) => at > position);
		if (after < 0) return;
		const before = after - 1;
		const next = asRecord(asRecord(entries[requests[after]].message).usage);
		const written = num(next.cacheWrite);
		const shrink =
			before >= 0
				? Math.max(0, promptTokens(asRecord(asRecord(entries[requests[before]].message).usage)) - promptTokens(next))
				: 0;
		const compaction = entries.findIndex((other, at) => at > position && other.type === "compaction");
		const end = compaction < 0 ? Infinity : compaction;
		const count = requests.filter((at) => at > position && at < end).length;
		const prices = asRecord(data.prices);
		const cold = data.rewriteAnyway === true;
		const priced = prices.unit === "usd-per-million" && num(prices.read) > 0 && num(prices.write) > 0;
		const read = num(prices.read);
		const write = num(prices.write);
		// Without clearing the next request would have read those tokens at the read price; the wave writes them once.
		const saved = shrink * read * count;
		const net = priced ? (saved - (cold ? 0 : written * (write - read))) / 1e6 : undefined;
		found.push({
			request: after,
			cold,
			written,
			shrink,
			requests: count,
			...(net === undefined ? {} : { net }),
			...(num(data.suffixTokens) > 0 ? { predictedWritten: num(data.suffixTokens) } : {}),
		});
	});
	return found;
}

function describe(wave: Wave): string {
	const net = wave.net === undefined ? "" : `, net ${usd(wave.net)}`;
	return `request ${wave.request}: freed ${thousands(wave.shrink)}, wrote ${thousands(wave.written)}, ${wave.requests} requests${net}`;
}

/**
 * Clearing findings of every lane: one per warm wave (the cache was still valid, so the wave paid a write for what it
 * freed) with its realized write, shrink, requests until the next compaction or the end, and net cost; the cold waves
 * (the cache was rewritten anyway) are listed apart in one finding per lane.
 */
export function clearingFindings(lanes: Lane[]): ProfileFinding[] {
	const found: ProfileFinding[] = [];
	for (const lane of lanes) {
		if (!lane.prepared) continue;
		const all = waves(lane.prepared);
		for (const wave of all.filter((each) => !each.cold))
			found.push({
				id: `${lane.id}:clearing:${wave.request}`,
				kind: "cost",
				severity: wave.net !== undefined && wave.net < -0.25 ? "medium" : "low",
				title: `Clearing wave at ${describe(wave)}`,
				detail:
					wave.net === undefined
						? "A warm wave: the next request wrote the cleared history again. The model lists no prices, so no net is computed."
						: wave.net < 0
							? "A warm wave that lost money: the cache write cost more than the freed tokens saved over the requests that followed."
							: "A warm wave that paid for itself: the freed tokens saved more than the cache write cost.",
				agentId: lane.id,
				tokens: wave.written,
				...(wave.net === undefined ? {} : { cost: Math.abs(wave.net) }),
				evidence: [{ agentId: lane.id, request: wave.request }],
			});
		const cold = all.filter((each) => each.cold);
		if (cold.length > 0)
			found.push({
				id: `${lane.id}:clearing-cold`,
				kind: "cost",
				severity: "low",
				title: `${cold.length} cold clearing wave${cold.length === 1 ? "" : "s"}: ${cold.map(describe).join("; ")}`,
				detail:
					"The cache was rewritten anyway (idle past its lifetime, a model switch or a prompt change), so clearing added no write.",
				agentId: lane.id,
				evidence: cold.map((wave) => ({ agentId: lane.id, request: wave.request })),
			});
	}
	return found;
}
