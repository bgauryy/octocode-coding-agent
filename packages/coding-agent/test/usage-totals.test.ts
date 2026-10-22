import type { Usage } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { combineUsage } from "../src/core/usage-totals.ts";

const legacy: Usage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 10,
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};

describe("mixed cache usage aggregation", () => {
	it("preserves long-write subsets without counting them again in token or cost totals", () => {
		const first = { ...legacy, cacheWrite12h: 2 };
		const second = { ...legacy, cacheWrite1h: 1, cacheWrite12h: 3 };
		expect(combineUsage(first, second)).toMatchObject({
			cacheWrite: 8,
			cacheWrite1h: 1,
			cacheWrite12h: 5,
			totalTokens: 20,
			cost: { total: 20 },
		});
	});
	it("keeps old transcripts readable without inventing a lifetime breakdown", () => {
		expect(combineUsage(legacy, legacy)).not.toHaveProperty("cacheWrite12h");
		expect(combineUsage(legacy, { ...legacy, cacheWrite12h: 2 }).cacheWrite12h).toBe(2);
	});
});
