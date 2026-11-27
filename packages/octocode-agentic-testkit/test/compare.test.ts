import { describe, expect, it } from "vitest";
import {
	assertVerdict,
	compareRates,
	liveCompare,
	runComparison,
	type ComparisonSummary,
	type VariantName,
} from "../src/compare.ts";
import { NoAnswer } from "../src/live.ts";

/**
 * Newcombe RG (1998), "Interval estimation for the difference between independent proportions: comparison of eleven
 * methods", Statistics in Medicine 17:873-890, Table II, method 10 (hybrid score, no continuity correction), 95%.
 * Each row is [x1, n1, x2, n2, lower, upper] for the difference x1/n1 - x2/n2.
 */
const NEWCOMBE_TABLE_II: [number, number, number, number, number, number][] = [
	[56, 70, 48, 80, 0.0524, 0.3339],
	[9, 10, 3, 10, 0.1705, 0.809],
	[6, 7, 2, 7, 0.0582, 0.8062],
	[5, 56, 0, 29, -0.0381, 0.1926],
	[0, 10, 0, 20, -0.1611, 0.2775],
	[0, 10, 0, 10, -0.2775, 0.2775],
	[10, 10, 0, 20, 0.6791, 1],
	[10, 10, 0, 10, 0.6075, 1],
];

describe("compareRates", () => {
	it.each(NEWCOMBE_TABLE_II)("%i/%i - %i/%i matches Newcombe 1998 Table II method 10", (x1, n1, x2, n2, lo, hi) => {
		// compareRates(a, b) is b - a, so the paper's first proportion is b.
		const c = compareRates({ successes: x2, trials: n2 }, { successes: x1, trials: n1 });
		expect(c.difference).toBeCloseTo(x1 / n1 - x2 / n2, 12);
		expect(c.interval[0]).toBeCloseTo(lo, 4);
		expect(c.interval[1]).toBeCloseTo(hi, 4);
		expect(c.confidence).toBe(0.95);
	});

	it("gives the verdict from where the interval lies", () => {
		const base = { successes: 48, trials: 80 };
		const treatment = { successes: 56, trials: 70 };
		expect(compareRates(base, treatment).verdict).toBe("better");
		expect(compareRates(treatment, base).verdict).toBe("worse");
		expect(compareRates({ successes: 5, trials: 56 }, { successes: 0, trials: 29 }).verdict).toBe("no-difference");
	});

	it("a higher confidence widens the interval until 0 falls inside it", () => {
		const a = { successes: 48, trials: 80 };
		const b = { successes: 56, trials: 70 };
		const at95 = compareRates(a, b);
		const at999 = compareRates(a, b, { confidence: 0.999 });
		expect(at999.interval[0]).toBeLessThan(at95.interval[0]);
		expect(at999.interval[1]).toBeGreaterThan(at95.interval[1]);
		expect(at999.verdict).toBe("no-difference");
	});

	it("rejects counts and confidences it cannot compare (must fail)", () => {
		expect(() => compareRates({ successes: 0, trials: 0 }, { successes: 1, trials: 2 })).toThrow(RangeError);
		expect(() => compareRates({ successes: 3, trials: 2 }, { successes: 1, trials: 2 })).toThrow(/a.successes=3/);
		expect(() => compareRates({ successes: 1, trials: 2 }, { successes: 1.5, trials: 2 })).toThrow(/b.successes/);
		expect(() => compareRates({ successes: 1, trials: 2 }, { successes: 1, trials: 2 }, { confidence: 1 })).toThrow(
			/confidence=1/,
		);
	});
});

describe("runComparison", () => {
	it("runs both variants the same number of times, interleaved with alternating order", async () => {
		const order: string[] = [];
		const s = await runComparison({
			variants: { base: "no-skill", treatment: "skill" },
			trials: 3,
			trial: ({ variant, name, trial }) => {
				order.push(`${name}${trial}`);
				return variant === "skill" || trial === 0;
			},
		});
		expect(order).toEqual(["base0", "treatment0", "treatment1", "base1", "base2", "treatment2"]);
		expect(s.base).toMatchObject({ trials: 3, successes: 1, failures: 2, errors: 0 });
		expect(s.treatment).toMatchObject({ trials: 3, successes: 3, failures: 0, passRate: 1 });
		expect(s.difference).toBeCloseTo(2 / 3, 12);
		expect(s.verdict).toBe("no-difference");
	});

	it("matches compareRates on the counts it observed", async () => {
		const pass = { base: 48, treatment: 56 };
		const counts: Record<VariantName, number> = { base: 0, treatment: 0 };
		const s = await runComparison({
			variants: { base: 0, treatment: 1 },
			trials: 80,
			trial: ({ name, trial }) => {
				counts[name]++;
				// treatment: 56 of its first 70 pass and the 10 extra trials fail, so 56/80 overall.
				return trial < pass[name];
			},
		});
		expect(counts).toEqual({ base: 80, treatment: 80 });
		const direct = compareRates({ successes: 48, trials: 80 }, { successes: 56, trials: 80 });
		expect(s.interval).toEqual(direct.interval);
		expect(s.verdict).toBe(direct.verdict);
	});

	it("counts NoAnswer as an error and any other throw as a failure", async () => {
		const s = await runComparison({
			variants: { base: "a", treatment: "b" },
			trials: 4,
			trial: ({ name, trial }) => {
				if (name === "base" && trial % 2) throw new NoAnswer("429");
				if (name === "treatment" && trial === 3) throw new Error("boom");
				return true;
			},
		});
		expect(s.base).toMatchObject({ trials: 2, successes: 2, failures: 0, errors: 2, lastError: "429" });
		expect(s.treatment).toMatchObject({ trials: 4, successes: 3, failures: 1, errors: 0, lastError: "boom" });
	});

	it("throws when a variant got no answer at all (must fail)", async () => {
		await expect(
			runComparison({
				variants: { base: 0, treatment: 1 },
				trials: 2,
				trial: ({ name }) => {
					if (name === "treatment") throw new NoAnswer("timeout");
					return true;
				},
			}),
		).rejects.toThrow(/treatment got no answer in 2 trials \(2 errors\); last error: timeout/);
	});

	it("throws on a trial that does not return a boolean (must fail)", async () => {
		await expect(
			runComparison({
				variants: { base: 0, treatment: 1 },
				trials: 1,
				trial: (() => undefined) as never,
			}),
		).rejects.toThrow(/the base trial 0 returned undefined; return true or false/);
	});

	it("rejects a bad trial count or confidence before running any trial", async () => {
		let n = 0;
		const trial = (): boolean => (n++, true);
		await expect(runComparison({ variants: { base: 0, treatment: 1 }, trials: 0, trial })).rejects.toThrow(RangeError);
		await expect(
			runComparison({ variants: { base: 0, treatment: 1 }, trials: 2, confidence: 0, trial }),
		).rejects.toThrow(/confidence=0/);
		expect(n).toBe(0);
	});
});

describe("assertVerdict", () => {
	const summary = (verdict: ComparisonSummary["verdict"]): ComparisonSummary => ({
		verdict,
		difference: 0.1,
		interval: [-0.2, 0.4],
		confidence: 0.95,
		base: { trials: 10, successes: 5, failures: 5, errors: 0, passRate: 0.5, interval: [0.2, 0.8] },
		treatment: { trials: 10, successes: 6, failures: 4, errors: 0, passRate: 0.6, interval: [0.3, 0.8] },
	});

	it("passes on an expected verdict and fails with both rates otherwise (must fail)", () => {
		expect(() => assertVerdict(summary("better"), "better")).not.toThrow();
		expect(() => assertVerdict(summary("no-difference"), ["no-difference", "better"])).not.toThrow();
		expect(() => assertVerdict(summary("no-difference"), "better")).toThrow(
			"compare no-difference, expected better: base 5/10, treatment 6/10, Δ 10.0% (95% CI -20.0% to 40.0%)",
		);
	});
});

describe("liveCompare", () => {
	liveCompare(
		"runs forced comparisons",
		{ variants: { base: false, treatment: true }, trials: 12, expect: "better", force: true },
		({ variant }) => variant,
	);
	it("stores the summary on task.meta", ({ task }) => {
		const meta = task.suite?.tasks[0]?.meta as { compare?: ComparisonSummary } | undefined;
		expect(meta?.compare).toMatchObject({ verdict: "better", treatment: { successes: 12 }, base: { successes: 0 } });
	});
});
liveCompare(
	"liveCompare without TESTKIT_LIVE is skipped",
	{ variants: { base: 0, treatment: 1 }, trials: 3, expect: "better" },
	() => {
		throw new Error("must not run");
	},
);
