import { test, type TestContext } from "vitest";
import { liveEnabled, NoAnswer, wilson } from "./live.ts";

/** A pass count out of answered trials. */
export interface Rate {
	successes: number;
	trials: number;
}

/** `better`: the treatment's rate is higher; `worse`: lower; `no-difference`: the interval contains 0. */
export type CompareVerdict = "better" | "worse" | "no-difference";

export interface RateComparison {
	/** Treatment rate minus base rate (b − a). */
	difference: number;
	/** Newcombe hybrid score interval of the difference (Newcombe 1998, method 10). */
	interval: [number, number];
	confidence: number;
	verdict: CompareVerdict;
}

// Acklam's rational approximation of the standard normal quantile; relative error below 1.15e-9.
const A = [
	-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239,
];
const B = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
const C = [
	-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
	2.938163982698783,
];
const D = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
const poly = (cs: number[], x: number): number => cs.reduce((acc, c) => acc * x + c, 0);

function normalQuantile(p: number): number {
	if (p < 0.02425) {
		const q = Math.sqrt(-2 * Math.log(p));
		return poly(C, q) / (poly(D, q) * q + 1);
	}
	if (p > 1 - 0.02425) return -normalQuantile(1 - p);
	const q = p - 0.5;
	const r = q * q;
	return (poly(A, r) * q) / (poly(B, r) * r + 1);
}

/** The two-sided normal quantile for a confidence level: 1.96 for 0.95. */
function zOf(fn: string, confidence: number): number {
	if (!(confidence > 0 && confidence < 1))
		throw new RangeError(`${fn}: confidence=${confidence} must be between 0 and 1`);
	return normalQuantile(1 - (1 - confidence) / 2);
}

function checkRate(label: string, r: Rate): void {
	if (!Number.isInteger(r.trials) || r.trials < 1)
		throw new RangeError(`compareRates: ${label}.trials=${r.trials} must be an integer of at least 1`);
	if (!Number.isInteger(r.successes) || r.successes < 0 || r.successes > r.trials)
		throw new RangeError(`compareRates: ${label}.successes=${r.successes} must be an integer from 0 to ${r.trials}`);
}

/**
 * Compare two pass rates measured on independent trials: the difference b − a, its Newcombe hybrid score interval
 * (Wilson intervals of each rate combined; Newcombe 1998, method 10) and a verdict from where the interval lies.
 * `no-difference` only says the interval contains 0; it is not evidence that the rates are equal.
 */
export function compareRates(a: Rate, b: Rate, opts: { confidence?: number } = {}): RateComparison {
	const confidence = opts.confidence ?? 0.95;
	const z = zOf("compareRates", confidence);
	checkRate("a", a);
	checkRate("b", b);
	const pa = a.successes / a.trials;
	const pb = b.successes / b.trials;
	const [la, ua] = wilson(a.successes, a.trials, z);
	const [lb, ub] = wilson(b.successes, b.trials, z);
	const difference = pb - pa;
	const lo = difference - Math.sqrt((pb - lb) ** 2 + (ua - pa) ** 2);
	const hi = difference + Math.sqrt((ub - pb) ** 2 + (pa - la) ** 2);
	const verdict: CompareVerdict = lo > 0 ? "better" : hi < 0 ? "worse" : "no-difference";
	return { difference, interval: [lo, hi], confidence, verdict };
}

export type VariantName = "base" | "treatment";

/** One trial of one variant; must return `true` (pass) or `false` (fail). Throw `NoAnswer` when no answer came back. */
export type CompareTrial<V> = (info: { variant: V; name: VariantName; trial: number }) => Promise<boolean> | boolean;

export interface CompareOptions<V> {
	/** What the trial receives: `base` is the baseline (no plugin, the full surface), `treatment` the change. */
	variants: { base: V; treatment: V };
	/** Trials per variant. */
	trials: number;
	/** Default 0.95. */
	confidence?: number;
}

export interface VariantResult {
	/** Answered trials: successes + failures. */
	trials: number;
	successes: number;
	failures: number;
	/** Trials that threw `NoAnswer`: neither a pass nor a failure. */
	errors: number;
	/** successes / answered trials. */
	passRate: number;
	/** Wilson interval of the pass rate at the comparison's confidence. */
	interval: [number, number];
	lastError?: string;
}

export interface ComparisonSummary extends RateComparison {
	base: VariantResult;
	treatment: VariantResult;
}

interface Tally {
	successes: number;
	failures: number;
	errors: number;
	lastError?: string;
}

/**
 * Run `trial` `trials` times per variant, interleaved: each round runs both variants, alternating which goes first, so
 * drift over time (rate limits, a warming cache) hits both alike. `false` or a thrown error is a failure; a thrown
 * `NoAnswer` is an error. A trial that returns anything but a boolean, or a variant with no answered trial, throws.
 */
export async function runComparison<V>(
	opts: CompareOptions<V> & { trial: CompareTrial<V> },
): Promise<ComparisonSummary> {
	if (!Number.isInteger(opts.trials) || opts.trials < 1)
		throw new RangeError(`runComparison: trials=${opts.trials} must be an integer of at least 1`);
	const confidence = opts.confidence ?? 0.95;
	const z = zOf("runComparison", confidence);
	const tally: Record<VariantName, Tally> = {
		base: { successes: 0, failures: 0, errors: 0 },
		treatment: { successes: 0, failures: 0, errors: 0 },
	};
	const once = async (name: VariantName, trial: number): Promise<void> => {
		const t = tally[name];
		let ok: unknown;
		try {
			ok = await opts.trial({ variant: opts.variants[name], name, trial });
		} catch (e) {
			if (e instanceof NoAnswer) t.errors++;
			else t.failures++;
			t.lastError = e instanceof Error ? e.message : String(e);
			return;
		}
		if (typeof ok !== "boolean")
			throw new TypeError(`runComparison: the ${name} trial ${trial} returned ${typeof ok}; return true or false`);
		if (ok) t.successes++;
		else t.failures++;
	};
	for (let trial = 0; trial < opts.trials; trial++) {
		const order: VariantName[] = trial % 2 === 0 ? ["base", "treatment"] : ["treatment", "base"];
		// oxlint-disable-next-line no-await-in-loop -- a round runs the variants one after another, alternating which goes first, so drift hits both alike
		for (const name of order) await once(name, trial);
	}
	for (const name of ["base", "treatment"] as const) {
		const t = tally[name];
		if (t.successes + t.failures === 0)
			throw new Error(
				`runComparison: ${name} got no answer in ${opts.trials} trials (${t.errors} errors)${t.lastError ? `; last error: ${t.lastError}` : ""}`,
			);
	}
	const result = (t: Tally): VariantResult => {
		const trials = t.successes + t.failures;
		return {
			trials,
			successes: t.successes,
			failures: t.failures,
			errors: t.errors,
			passRate: t.successes / trials,
			interval: wilson(t.successes, trials, z),
			...(t.lastError === undefined ? {} : { lastError: t.lastError }),
		};
	};
	const base = result(tally.base);
	const treatment = result(tally.treatment);
	return { ...compareRates(base, treatment, { confidence }), base, treatment };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** One line: both rates, the difference and its interval. */
export function formatComparison(s: ComparisonSummary): string {
	const [lo, hi] = s.interval;
	return `base ${s.base.successes}/${s.base.trials}, treatment ${s.treatment.successes}/${s.treatment.trials}, Δ ${pct(s.difference)} (${Math.round(s.confidence * 100)}% CI ${pct(lo)} to ${pct(hi)})`;
}

/** Throws unless the summary's verdict is one of `expected`. */
export function assertVerdict(s: ComparisonSummary, expected: CompareVerdict | readonly CompareVerdict[]): void {
	const wanted: readonly CompareVerdict[] = typeof expected === "string" ? [expected] : expected;
	if (!wanted.includes(s.verdict))
		throw new Error(`compare ${s.verdict}, expected ${wanted.join(" or ")}: ${formatComparison(s)}`);
}

export interface LiveCompareOptions<V> extends CompareOptions<V> {
	/** The verdicts that pass the test. `no-difference` passes on too few trials too, so pair it with enough of them. */
	expect: CompareVerdict | readonly CompareVerdict[];
	/** Run even without TESTKIT_LIVE=1. */
	force?: boolean;
}

/**
 * A paid A/B or ablation test: skipped (with a reason) unless TESTKIT_LIVE=1 or `force`. Stores the summary on
 * `task.meta.compare` and fails when the verdict is not one of `expect`.
 */
export function liveCompare<V>(name: string, opts: LiveCompareOptions<V>, trial: CompareTrial<V>): void {
	test(name, async (ctx: TestContext): Promise<void> => {
		if (!opts.force && !liveEnabled()) return ctx.skip("live test: set TESTKIT_LIVE=1 to run");
		const summary = await runComparison({ ...opts, trial });
		(ctx.task.meta as Record<string, unknown>).compare = summary;
		assertVerdict(summary, opts.expect);
	});
}
