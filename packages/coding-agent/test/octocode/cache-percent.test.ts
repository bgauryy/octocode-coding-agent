import { describe, expect, it } from "vitest";
import { cachedPercent } from "../../src/octocode/shared/format.ts";
import { childCacheLabel } from "../../src/octocode/subagents/cache-monitor.ts";

describe("cachedPercent", () => {
	it("rounds, but never to 100 below a full read or to 0 above none", () => {
		expect(cachedPercent(996, 1000)).toBe(99);
		expect(cachedPercent(9996, 10_000, 1)).toBe(99.9);
		expect(cachedPercent(1, 1000)).toBe(1);
		expect(cachedPercent(1, 100_000, 1)).toBe(0.1);
		expect(cachedPercent(745, 1000)).toBe(75);
		expect(cachedPercent(1000, 1000)).toBe(100);
		expect(cachedPercent(0, 1000)).toBe(0);
	});

	it("has no rate without prompt tokens", () => {
		expect(cachedPercent(0, 0)).toBeUndefined();
		expect(cachedPercent(5, Number.NaN)).toBeUndefined();
	});

	it("keeps a nearly full cache from reading as fully cached in the child label", () => {
		expect(childCacheLabel({ promptTokens: 100_000, cacheRead: 99_600, cacheWrite: 400 })).toMatch(/^99% cached/);
	});
});
