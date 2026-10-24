import { describe, expect, it } from "vitest";
import { calculateCost } from "../src/models.ts";
import type { Model, Usage } from "../src/types.ts";

const model = (cost: Model<"anthropic-messages">["cost"]): Model<"anthropic-messages"> => ({
	id: "m",
	name: "m",
	provider: "p",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 1000,
	cost,
});

const usage = (fields: Partial<Usage>): Usage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	...fields,
});

describe("calculateCost cache writes", () => {
	const priced = model({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });

	it("prices 5m writes at the cache-write rate and 1h writes at twice the input rate", () => {
		const cost = calculateCost(priced, usage({ cacheWrite: 3_000_000, cacheWrite1h: 1_000_000 }));
		// 2M short writes at $5 and 1M long writes at $8.
		expect(cost.cacheWrite).toBeCloseTo(18, 10);
	});

	it("prices 12h writes at 2.5 times the input rate", () => {
		const cost = calculateCost(priced, usage({ cacheWrite: 1_000_000, cacheWrite12h: 1_000_000 }));
		expect(cost.cacheWrite).toBeCloseTo(10, 10);
	});

	it("applies long-write multipliers to the matched tier's input rate", () => {
		const tiered = model({
			input: 4,
			output: 20,
			cacheRead: 0.2,
			cacheWrite: 5,
			tiers: [{ inputTokensAbove: 200_000, input: 8, output: 30, cacheRead: 0.4, cacheWrite: 10 }],
		});
		const cost = calculateCost(tiered, usage({ cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }));
		expect(cost.cacheWrite).toBeCloseTo(16, 10);
	});

	it("adds no long-write premium for a model that declares no cache-write rate", () => {
		// Older OpenAI models: extended retention without a write charge, so long writes cost what short writes cost.
		const unpriced = model({ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 });
		const cost = calculateCost(
			unpriced,
			usage({ cacheWrite: 1_000_000, cacheWrite12h: 600_000, cacheWrite1h: 400_000 }),
		);
		expect(cost.cacheWrite).toBe(0);
	});
});
