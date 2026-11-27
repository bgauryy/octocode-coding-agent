import {
	cacheBreaks,
	cacheReadRatio,
	duplicateBlocks,
	growth,
	prefixBreaks,
	type CacheBreakOptions,
} from "../context.ts";
import { cannot, fail, needTrace, type Result } from "./shared.ts";

export const contextMatchers = {
	toKeepStablePrefix(received: unknown, o: { allowAfterCompaction?: boolean; raw?: boolean } = {}): Result {
		const t = needTrace(received);
		if (t.requests.length < 2) return cannot("need at least two requests");
		const breaks = prefixBreaks(t, o);
		return {
			pass: breaks.length === 0,
			message: () =>
				breaks.length
					? `prefix not stable: ${breaks.map((b) => `request ${b.request} (${b.agent}) ${b.reason} at message ${b.messageIndex}`).join("; ")}`
					: "expected the prefix to break, but it was stable",
		};
	},

	toHaveNoDuplicateBlocks(received: unknown, o: { minChars?: number } = {}): Result {
		const t = needTrace(received);
		if (!t.requests.length) return cannot("no requests");
		const dups = duplicateBlocks(t, o.minChars);
		return {
			pass: dups.length === 0,
			message: () =>
				dups.length
					? `duplicate blocks: ${dups.map((d) => `request ${d.request} x${d.count} "${d.preview}"`).join("; ")}`
					: "expected duplicate blocks, found none",
		};
	},

	toGrowAtMost(received: unknown, bytesPerTurn: number): Result {
		const t = needTrace(received);
		const agents = [...new Set(t.requests.map((r) => r.agent))];
		let compared = 0;
		for (const a of agents) {
			const reqs = t.requests.filter((r) => r.agent === a);
			const sizes = growth(t, a);
			for (let i = 1; i < sizes.length; i++) {
				compared++;
				const delta = sizes[i] - sizes[i - 1];
				if (delta > bytesPerTurn)
					return fail(
						`request ${reqs[i].index} (${a}) grew ${delta} bytes over the previous one, limit ${bytesPerTurn}`,
					);
			}
		}
		if (!compared) return cannot("need two requests of one agent");
		return { pass: true, message: () => `expected growth above ${bytesPerTurn} bytes per turn` };
	},

	toHaveCacheReadRatio(received: unknown, o: { min: number }): Result {
		const t = needTrace(received);
		if (!t.requests.some((r) => r.usage)) return cannot("no usage on any request");
		const ratio = cacheReadRatio(t);
		return {
			pass: ratio >= o.min,
			message: () =>
				`cache read ratio ${ratio.toFixed(3)} (${t.requests.some((r) => r.usage?.estimated) ? "estimated" : "reported"}), min ${o.min}`,
		};
	},

	toKeepCacheWarm(received: unknown, o: CacheBreakOptions = {}): Result {
		const t = needTrace(received);
		const reqs = t.requests.filter((r) => o.agent === undefined || r.agent === o.agent);
		if (!reqs.some((r) => r.usage)) return cannot(`no usage on any request${o.agent ? ` of ${o.agent}` : ""}`);
		const breaks = cacheBreaks(t, o);
		const estimated = reqs.some((r) => r.usage?.estimated) ? " (estimated usage)" : "";
		return {
			pass: breaks.length === 0,
			message: () =>
				breaks.length
					? `cold cache reads${estimated}: ${breaks.map((b) => `request ${b.request} (${b.agent}) read 0 of ${b.promptTokens} prompt tokens from cache`).join("; ")}`
					: `expected a cold cache read after warm-up${estimated}, but every request from the second on read from cache`,
		};
	},
};
