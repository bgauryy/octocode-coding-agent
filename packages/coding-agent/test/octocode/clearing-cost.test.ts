import { describe, expect, it } from "vitest";
import {
	cachePrices,
	DEFAULT_LONG_WRITE_RATIO,
	DEFAULT_READ_RATIO,
	DEFAULT_SHORT_WRITE_RATIO,
	expectedRemainingRequests,
} from "../../src/octocode/compaction/clearing-cost.ts";

const HOUR = 3_600_000;
const anthropic = {
	provider: "p",
	id: "m",
	api: "anthropic-messages",
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
} as never;
const noPremium = {
	provider: "p",
	id: "m",
	api: "openai-responses",
	cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
} as never;

describe("the cost of clearing old tool results", () => {
	it("expects as many more requests as the context has seen, capped by the room left in its window", () => {
		expect(expectedRemainingRequests(0, 1_000, 200_000)).toBe(0);
		expect(expectedRemainingRequests(40, 80_000)).toBe(40);
		// 2,000 tokens per request and 120,000 tokens of room: 60 more would fit, the 40 seen so far is the estimate.
		expect(expectedRemainingRequests(40, 80_000, 200_000)).toBe(40);
		// 4,000 tokens per request and 40,000 of room: 10 more before the window is full.
		expect(expectedRemainingRequests(40, 160_000, 200_000)).toBe(10);
		expect(expectedRemainingRequests(40, 220_000, 200_000)).toBe(0);
	});

	it("measures growth from the size the context started at, so a large fixed prefix or a summary does not count as growth", () => {
		// 40 requests grew the context from 97k to 230k: 3,325 tokens each, so 41k of room lasts about 12 more.
		expect(expectedRemainingRequests(40, 230_000, 271_000, 97_000)).toBeCloseTo(41_000 / 3_325, 1);
		// No growth measured: the room is not the limit, the requests seen so far are.
		expect(expectedRemainingRequests(40, 97_000, 271_000, 97_000)).toBe(40);
		expect(expectedRemainingRequests(40, 90_000, 271_000, 97_000)).toBe(40);
	});

	it("reads the model's catalog prices at the cache lifetime, and Anthropic's ratios without them", () => {
		const long = cachePrices(anthropic, HOUR);
		const short = cachePrices(anthropic, 300_000);
		// A 1-hour write costs twice the input price, a 5-minute one the listed write price.
		expect(long.write / long.read).toBeCloseTo(6 / 0.3);
		expect(short.write / short.read).toBeCloseTo(3.75 / 0.3);
		// No write premium: a write costs the input price.
		const plain = cachePrices(noPremium, HOUR);
		expect(plain.write / plain.read).toBeCloseTo(2 / 0.5);
		expect(cachePrices(undefined, HOUR)).toEqual({ read: DEFAULT_READ_RATIO, write: DEFAULT_LONG_WRITE_RATIO });
		expect(cachePrices(undefined, 300_000)).toEqual({ read: DEFAULT_READ_RATIO, write: DEFAULT_SHORT_WRITE_RATIO });
		const free = { ...(anthropic as object), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as never;
		expect(cachePrices(free, HOUR)).toEqual({ read: DEFAULT_READ_RATIO, write: DEFAULT_LONG_WRITE_RATIO });
	});
});
