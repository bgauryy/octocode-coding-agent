import type { Model } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { getPromptCacheTtlMs } from "../src/core/cache-warmer.ts";

const model: Model<"anthropic-messages"> = {
	id: "test",
	name: "Test",
	provider: "anthropic",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	promptCache: { short: 300, long: 3600 },
};

describe("layered cache warming", () => {
	it("does not schedule a whole-prompt refresh using the lifetime of just the history", () => {
		expect(getPromptCacheTtlMs(model, { cacheRetention: "short", instructionCacheRetention: "long" })).toBeUndefined();
	});
	it("preserves Pi warming for a single lifetime and honors explicit disabling", () => {
		expect(getPromptCacheTtlMs(model, { cacheRetention: "long" })).toBe(3600000);
		expect(getPromptCacheTtlMs(model, { cacheRetention: "none", instructionCacheRetention: "long" })).toBeUndefined();
		expect(getPromptCacheTtlMs(model, { env: { OCTOCODE_CACHE_RETENTION: "none" } })).toBeUndefined();
	});
});
