import { describe, expect, it } from "vitest";
import { cacheUnusable, promptCacheTtlMs } from "../../src/octocode/compaction/cache.ts";

const session = { getBranch: () => [] };

describe("speculative compaction cache gate", () => {
	it("treats a missing lifetime (retention none, no cache) as unusable and a known lifetime with no use yet as usable", () => {
		const lifetimes = { short: 300, long: 3600 };
		expect(cacheUnusable(session, promptCacheTtlMs(lifetimes, { OCTOCODE_CACHE_RETENTION: "none" }))).toBe(true);
		expect(cacheUnusable(session, promptCacheTtlMs(undefined, {}))).toBe(true);
		expect(cacheUnusable(session, promptCacheTtlMs(lifetimes, {}))).toBe(false);
	});
});
