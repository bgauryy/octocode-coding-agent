import { afterEach, describe, expect, it, vi } from "vitest";
import { activeRates, calculateCost } from "../src/models.ts";
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

/** One million of each billed class, so each cost field equals its per-million rate. */
const million = () => usage({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000 });

const intro = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 };
const regular = { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 0 };

describe("calculateCost dated prices", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const dated = model({ ...intro, until: "2026-12-31", after: regular });

	it("charges the listed rates through the whole `until` day (UTC)", () => {
		for (const now of ["2026-11-01T00:00:00Z", "2026-12-31T00:00:00Z", "2026-12-31T23:59:59.999Z"]) {
			const cost = calculateCost(dated, million(), new Date(now));
			expect(cost.input).toBeCloseTo(0.75, 10);
			expect(cost.output).toBeCloseTo(3.75, 10);
			expect(cost.cacheRead).toBeCloseTo(0.075, 10);
		}
	});

	it("charges the `after` rates from the first instant after the `until` day", () => {
		for (const now of ["2027-01-01T00:00:00Z", "2027-06-01T12:00:00Z"]) {
			const cost = calculateCost(dated, million(), new Date(now));
			expect(cost.input).toBeCloseTo(1.5, 10);
			expect(cost.output).toBeCloseTo(7.5, 10);
			expect(cost.cacheRead).toBeCloseTo(0.15, 10);
			expect(cost.total).toBeCloseTo(9.15, 10);
		}
	});

	it("accepts the clock as epoch milliseconds", () => {
		const before = Date.parse("2026-12-31T23:59:59.999Z");
		expect(calculateCost(dated, million(), before).input).toBeCloseTo(0.75, 10);
		expect(calculateCost(dated, million(), before + 1).input).toBeCloseTo(1.5, 10);
	});

	it("reads the system clock when none is injected", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-12-31T23:59:59.999Z"));
		expect(calculateCost(dated, million()).input).toBeCloseTo(0.75, 10);
		vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
		expect(calculateCost(dated, million()).input).toBeCloseTo(1.5, 10);
	});

	it("applies the active period's own context tiers", () => {
		const tiered = model({
			...intro,
			tiers: [{ inputTokensAbove: 200_000, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 }],
			until: "2026-12-31",
			after: {
				...regular,
				tiers: [{ inputTokensAbove: 200_000, input: 3, output: 11, cacheRead: 0.3, cacheWrite: 0 }],
			},
		});
		expect(calculateCost(tiered, million(), new Date("2026-12-31T00:00:00Z")).input).toBeCloseTo(1, 10);
		expect(calculateCost(tiered, million(), new Date("2027-01-01T00:00:00Z")).input).toBeCloseTo(3, 10);
		// Below the tier threshold the period's base rate applies.
		const small = usage({ input: 100_000 });
		expect(calculateCost(tiered, small, new Date("2027-01-01T00:00:00Z")).input).toBeCloseTo(0.15, 10);
	});

	it("keeps the listed rates when there is no fallback or the date is unreadable", () => {
		const late = new Date("2030-01-01T00:00:00Z");
		expect(calculateCost(model({ ...intro, until: "2026-12-31" }), million(), late).input).toBeCloseTo(0.75, 10);
		expect(calculateCost(model({ ...intro, until: "soon", after: regular }), million(), late).input).toBeCloseTo(
			0.75,
			10,
		);
		expect(calculateCost(model({ ...intro, after: regular }), million(), late).input).toBeCloseTo(0.75, 10);
	});
});

describe("activeRates", () => {
	const dated = {
		...intro,
		tiers: [{ inputTokensAbove: 200_000, input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 }],
		until: "2026-12-31",
		after: {
			...regular,
			tiers: [{ inputTokensAbove: 200_000, input: 3, output: 11, cacheRead: 0.3, cacheWrite: 0 }],
		},
	};

	it("returns the listed rates and tiers through the `until` day", () => {
		for (const now of [new Date("2026-11-01T00:00:00Z"), Date.parse("2026-12-31T23:59:59.999Z")]) {
			const rates = activeRates(dated, now);
			expect(rates).toMatchObject(intro);
			expect(rates.tiers?.[0]?.input).toBe(1);
		}
	});

	it("returns the `after` rates and tiers from the day after `until`", () => {
		for (const now of [new Date("2027-01-01T00:00:00Z"), Date.parse("2030-06-01T00:00:00Z")]) {
			const rates = activeRates(dated, now);
			expect(rates).toMatchObject(regular);
			expect(rates.tiers?.[0]?.input).toBe(3);
		}
	});

	it("agrees with calculateCost at the same instant", () => {
		const now = new Date("2027-01-01T00:00:00Z");
		// 100k input stays below the 200k tier threshold, so the base rates of the period apply.
		const small = usage({ input: 100_000, output: 1_000_000, cacheRead: 0 });
		const priced = calculateCost(model(dated), small, now);
		const rates = activeRates(dated, now);
		expect(priced.input).toBeCloseTo(rates.input / 10, 10);
		expect(priced.output).toBeCloseTo(rates.output, 10);
	});

	it("keeps the listed rates without a fallback or with an unreadable date", () => {
		const late = new Date("2030-01-01T00:00:00Z");
		expect(activeRates({ ...intro, until: "2026-12-31" }, late)).toMatchObject(intro);
		expect(activeRates({ ...intro, until: "soon", after: regular }, late)).toMatchObject(intro);
		expect(activeRates({ ...intro, after: regular }, late)).toMatchObject(intro);
	});

	it("reads the system clock when none is injected", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2027-01-01T00:00:00Z"));
			expect(activeRates(dated).input).toBe(1.5);
		} finally {
			vi.useRealTimers();
		}
	});
});
