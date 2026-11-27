import { activeRates, calculateCost, type Model } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import type { ModelsJsonModelOverride } from "../src/core/model-config.ts";
import { applyModelOverride } from "../src/core/provider-composer/models.ts";
import { unpricedModel } from "../src/octocode/shared/util.ts";

const DURING = new Date("2026-12-31T12:00:00Z");
const AFTER = new Date("2027-01-02T12:00:00Z");

const builtIn: Model<"anthropic-messages"> = {
	id: "m",
	name: "m",
	provider: "p",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 1000,
	cost: {
		input: 0.75,
		output: 3.75,
		cacheRead: 0.075,
		cacheWrite: 0,
		until: "2026-12-31",
		after: { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 },
	},
};

const override = (cost: NonNullable<ModelsJsonModelOverride["cost"]>) => applyModelOverride(builtIn, { cost });

describe("modelOverrides cost and the built-in dated price", () => {
	it("charges a user's rates on both sides of the built-in date", () => {
		const model = override({ input: 2, output: 10 });
		for (const now of [DURING, AFTER]) {
			const rates = activeRates(model.cost, now);
			expect(rates).toMatchObject({ input: 2, output: 10, cacheRead: 0.075 });
		}
		const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
		const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		expect(calculateCost(model, { ...usage, cost: zero() }, AFTER).input).toBeCloseTo(2, 10);
	});

	it("drops the built-in window when only the tiers are overridden", () => {
		const tiers = [{ inputTokensAbove: 50_000, input: 9, output: 9, cacheRead: 9, cacheWrite: 9 }];
		const model = override({ tiers });
		expect(model.cost.until).toBeUndefined();
		expect(model.cost.after).toBeUndefined();
		expect(activeRates(model.cost, AFTER)).toMatchObject({ input: 0.75, tiers });
	});

	it("keeps the built-in window when the override sets no rate", () => {
		const unchanged = override({});
		expect(activeRates(unchanged.cost, DURING).input).toBe(0.75);
		expect(activeRates(unchanged.cost, AFTER).input).toBe(1.5);
		// A window-only override moves the end of the introductory price and keeps the built-in rates.
		const extended = override({ until: "2027-06-30" });
		expect(activeRates(extended.cost, AFTER).input).toBe(0.75);
		expect(activeRates(extended.cost, new Date("2027-07-01T00:00:00Z")).input).toBe(1.5);
	});

	it("uses the override's own window instead of the built-in one", () => {
		const model = override({
			input: 2,
			output: 10,
			cacheRead: 0.2,
			cacheWrite: 0,
			until: "2027-03-31",
			after: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 0 },
		});
		expect(activeRates(model.cost, DURING)).toMatchObject({ input: 2, output: 10 });
		expect(activeRates(model.cost, AFTER)).toMatchObject({ input: 2, output: 10 });
		expect(activeRates(model.cost, new Date("2027-04-01T00:00:00Z"))).toMatchObject({ input: 4, output: 20 });
	});

	it("leaves a model without an override untouched", () => {
		expect(applyModelOverride(builtIn, {}).cost).toBe(builtIn.cost);
	});
});

describe("unpricedModel with a dated price", () => {
	const find = () => ({
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			until: "2026-12-31",
			after: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		},
	});
	const reply = (timestamp: number) => ({
		provider: "p",
		model: "m",
		timestamp,
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
	});

	it("calls a free introductory period unpriced only while it lasts", () => {
		expect(unpricedModel(reply(DURING.getTime()), find)).toBe("p/m");
		expect(unpricedModel(reply(AFTER.getTime()), find)).toBeUndefined();
	});
});
