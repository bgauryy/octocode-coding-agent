import { describe, expect, it } from "vitest";
import { cacheUnusable } from "../../src/octocode/compaction/cache.ts";

const session = { getBranch: () => [] };
const now = Date.parse("2026-11-24T14:00:00Z");
/** A session whose latest reply came `ageMs` ago with this cache usage. */
const replied = (ageMs: number, usage: { cacheRead: number; cacheWrite: number }) => {
	const branch = [
		{ type: "message", id: "a1", message: { role: "assistant", timestamp: now - ageMs, stopReason: "toolUse", usage } },
	];
	return { getBranch: () => branch };
};

describe("speculative compaction cache gate", () => {
	it("treats retention none and a model that has not cached as unusable, and a known lifetime with no use yet as usable", () => {
		const lifetimes = { short: 300, long: 3600 };
		expect(cacheUnusable(session, lifetimes, { OCTOCODE_CACHE_RETENTION: "none" }, now)).toBe(true);
		expect(cacheUnusable(session, undefined, {}, now)).toBe(true);
		expect(cacheUnusable(session, lifetimes, {}, now)).toBe(false);
	});

	// Kimi K3.1 on Bedrock declares no lifetime, yet each turn read 207k-245k cached tokens: its early summary never ran.
	it("trusts an undeclared lifetime for five minutes after a reply that read the cache", () => {
		const read = { cacheRead: 207_000, cacheWrite: 0 };
		expect(cacheUnusable(replied(4_000, read), undefined, {}, now)).toBe(false);
		expect(cacheUnusable(replied(299_000, read), undefined, {}, now)).toBe(false);
		expect(cacheUnusable(replied(301_000, read), undefined, {}, now)).toBe(true);
	});

	it("keeps an undeclared lifetime unusable when the replies show no caching or caching is off", () => {
		expect(cacheUnusable(replied(4_000, { cacheRead: 0, cacheWrite: 0 }), undefined, {}, now)).toBe(true);
		const read = replied(4_000, { cacheRead: 207_000, cacheWrite: 0 });
		expect(cacheUnusable(read, undefined, { OCTOCODE_CACHE_RETENTION: "none" }, now)).toBe(true);
	});
});
