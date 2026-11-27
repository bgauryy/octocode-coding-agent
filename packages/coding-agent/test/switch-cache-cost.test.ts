import { describe, expect, it } from "vitest";
import { switchCacheNotice } from "../src/core/switch-cache-cost.ts";

const usage = (cacheRead: number, cacheWrite: number) => ({
	input: 10,
	output: 5,
	cacheRead,
	cacheWrite,
	totalTokens: cacheRead + cacheWrite + 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const sonnet = {
	provider: "anthropic-custom",
	id: "claude-sonnet-5-5",
	cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
};
const haiku = {
	provider: "anthropic-custom",
	id: "claude-haiku-5-5",
	cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
const flat = { provider: "other", id: "plain", cost: { input: 3, output: 6, cacheRead: 0, cacheWrite: 0 } };

describe("switchCacheNotice", () => {
	const last = { usage: usage(40_000, 12_000) };

	it("prices the cached prefix at the target's cache-write rate", () => {
		expect(switchCacheNotice(last, haiku, sonnet)).toBe(
			"switching rewrites ~52k cached tokens (~$0.13 at claude-sonnet-5-5's cache-write price)",
		);
	});

	it("falls back to the input rate when the target has no cache-write rate", () => {
		expect(switchCacheNotice(last, sonnet, flat)).toBe(
			"switching rewrites ~52k cached tokens (~$0.16 at plain's cache-write price)",
		);
	});

	it("says nothing when the cache key stays, nothing was cached, or no reply exists", () => {
		expect(switchCacheNotice(last, sonnet, sonnet)).toBeUndefined();
		expect(switchCacheNotice({ usage: usage(0, 0) }, haiku, sonnet)).toBeUndefined();
		expect(switchCacheNotice(undefined, haiku, sonnet)).toBeUndefined();
	});

	it("shows a different provider with the same model id", () => {
		expect(switchCacheNotice(last, { ...sonnet, provider: "x" }, sonnet)).toContain("~52k");
	});
});
