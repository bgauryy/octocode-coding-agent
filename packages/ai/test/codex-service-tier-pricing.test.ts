import { describe, expect, it } from "vitest";
import {
	applyServiceTierPricing as applyCodexServiceTierPricing,
	resolveCodexServiceTier,
} from "../src/api/openai-codex-responses/request.ts";
import { applyServiceTierPricing as applyResponsesServiceTierPricing } from "../src/api/openai-responses/request.ts";
import type { Usage } from "../src/types.ts";

const usage = (): Usage => ({
	input: 1,
	output: 1,
	cacheRead: 1,
	cacheWrite: 1,
	totalTokens: 4,
	cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
});

describe("Codex and Responses service-tier pricing", () => {
	it.each([
		["gpt-5.5", "flex", 0.5],
		["gpt-5.5", "priority", 2.5],
		["gpt-6-luna", "priority", 2],
		// GPT-6 models report Fast mode as "fast"; Codex serves the same models.
		["gpt-6-luna", "fast", 2],
		["gpt-6-astra", "ultrafast", 6],
		["gpt-6.1-sol", "ultrafast", 6],
		["gpt-6-luna", "default", 1],
	] as const)("prices %s %s at %sx on both transports", (id, tier, multiplier) => {
		const codex = usage();
		const responses = usage();
		applyCodexServiceTierPricing(codex, tier, { id });
		applyResponsesServiceTierPricing(responses, tier, { id });
		expect(codex.cost).toEqual(responses.cost);
		expect(codex.cost.input).toBe(multiplier);
		expect(codex.cost.output).toBe(multiplier);
		expect(codex.cost.cacheRead).toBe(multiplier);
		expect(codex.cost.cacheWrite).toBe(multiplier);
		expect(codex.cost.total).toBeCloseTo(4 * multiplier, 12);
	});

	it("keeps a requested Fast tier when Codex echoes default", () => {
		expect(resolveCodexServiceTier("default", "fast")).toBe("fast");
		expect(resolveCodexServiceTier("default", "priority")).toBe("priority");
		expect(resolveCodexServiceTier("fast", "priority")).toBe("fast");
		expect(resolveCodexServiceTier(undefined, "flex")).toBe("flex");
	});
});
