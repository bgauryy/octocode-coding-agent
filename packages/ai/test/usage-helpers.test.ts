import { describe, expect, it } from "vitest";
import { createEmptyUsage, createUsage, sumUsageTokens } from "../src/utils/assistant-message.ts";

describe("usage helpers", () => {
	it("sums input, output and cache tokens when the provider reports no total", () => {
		expect(sumUsageTokens({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2 })).toBe(20);
	});

	it("prefers a non-zero provider total and falls back when it is zero or missing", () => {
		const counts = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 };
		expect(sumUsageTokens(counts, 99)).toBe(99);
		expect(sumUsageTokens(counts, 0)).toBe(20);
		expect(sumUsageTokens(counts, undefined)).toBe(20);
	});

	it("creates zero-cost usage with absent counts as zero and reasoning only when reported", () => {
		const usage = createUsage({ input: 4, output: 6 });
		expect(usage).toEqual({ ...createEmptyUsage(), input: 4, output: 6, totalTokens: 10 });
		expect("reasoning" in usage).toBe(false);
		expect(createUsage({ input: 1, output: 2, reasoning: 0, totalTokens: 7 })).toMatchObject({
			reasoning: 0,
			totalTokens: 7,
		});
	});

	it("does not share the cost object between usages", () => {
		const first = createUsage({ input: 1, output: 1 });
		first.cost.total = 5;
		expect(createUsage({ input: 1, output: 1 }).cost.total).toBe(0);
	});
});
