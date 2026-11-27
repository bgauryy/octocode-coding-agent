import { test, type TestContext } from "vitest";

/** P(rate > threshold) under a Beta(1+s, 1+f) posterior (uniform prior); exact for integer counts. */
export function posteriorAbove(successes: number, failures: number, threshold: number): number {
	const a = successes + 1;
	const b = failures + 1;
	const n = a + b - 1;
	const logChoose = (k: number): number => {
		let s = 0;
		for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
		return s;
	};
	// I_x(a, b) = sum_{j=a}^{n} C(n, j) x^j (1-x)^(n-j), the chance of at least a successes in n draws.
	let cdf = 0;
	for (let j = a; j <= n; j++)
		cdf += Math.exp(logChoose(j) + j * Math.log(threshold) + (n - j) * Math.log(1 - threshold));
	return 1 - Math.min(1, cdf);
}

/** C(n, k) as a running product; each step is an exact integer, so small inputs stay exact. */
const choose = (n: number, k: number): number => {
	let r = 1;
	for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
	return r;
};

/**
 * pass^k, as in tau2-bench `agent_metrics.py`: C(successes, k) / C(trials, k), the estimated chance that k
 * independent trials all succeed. 0 when successes < k. Throws a RangeError on k < 1, k > trials or successes > trials.
 */
export function passHatK(trials: number, successes: number, k: number): number {
	if (!Number.isInteger(k) || k < 1 || k > trials)
		throw new RangeError(`passHatK: k=${k} must be an integer from 1 to trials=${trials}`);
	if (successes < 0 || successes > trials)
		throw new RangeError(`passHatK: successes=${successes} must be from 0 to trials=${trials}`);
	if (successes < k) return 0;
	return choose(successes, k) / choose(trials, k);
}

/**
 * Unbiased pass@k (Chen et al. 2021): the chance that at least one of k trials drawn from `trials` passes.
 * Throws a RangeError on the same inputs as `passHatK`.
 */
export function passAtK(trials: number, successes: number, k: number): number {
	passHatK(trials, successes, k);
	if (trials - successes < k) return 1;
	let none = 1;
	for (let i = trials - successes + 1; i <= trials; i++) none *= 1 - k / i;
	return 1 - none;
}

/** Wilson score interval for a pass rate measured on few runs; `z` 1.96 gives 95%. [0, 1] when runs is 0. */
export function wilson(successes: number, trials: number, z = 1.96): [number, number] {
	if (trials === 0) return [0, 1];
	const p = successes / trials;
	const denom = 1 + (z * z) / trials;
	const centre = (p + (z * z) / (2 * trials)) / denom;
	const half = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denom;
	return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export type Decision = "pass" | "fail" | "inconclusive";

/** pass when P(rate > threshold) >= confidence, fail when it is <= 1 - confidence, else inconclusive. */
export function decide(successes: number, failures: number, threshold: number, confidence = 0.95): Decision {
	const p = posteriorAbove(successes, failures, threshold);
	if (p >= confidence) return "pass";
	if (p <= 1 - confidence) return "fail";
	return "inconclusive";
}

export interface LiveOptions {
	maxTrials: number;
	/** Required pass rate. */
	threshold: number;
	minTrials?: number;
	confidence?: number;
	/** Run even without TESTKIT_LIVE=1. */
	force?: boolean;
	/** Consecutive-success count for pass^k; reported as `passHatK` once trials ≥ k. */
	k?: number;
}

/** Throw from a trial when it got no answer (timeout, 429, 5xx): counted in `errors`, neither a pass nor a failure. */
export class NoAnswer extends Error {
	override name = "NoAnswer";
}

export interface LiveSummary {
	decision: Decision;
	/** Answered trials: successes + failures. */
	trials: number;
	/** Trials that threw `NoAnswer`; they use up `maxTrials` but never move the decision. */
	errors?: number;
	successes: number;
	failures: number;
	/** successes / answered trials; 0 when no trial was answered. */
	passRate: number;
	/** pass^k over the answered trials, set when `k` is given and trials ≥ k. */
	passHatK?: number;
	probability: number;
	threshold: number;
	stoppedEarly: boolean;
	lastError?: string;
}

/**
 * One trial: return `true` when it passed and `false` when it failed, or throw. Any other return value (a trial
 * that forgot its `return`) counts as a failure, so a missing check never reads as a pass.
 */
export type Trial = (info: { trial: number }) => Promise<boolean> | boolean;

/** The failure message for a trial that returned something other than a boolean. */
const notBoolean = (v: unknown): string =>
	`trial returned ${v === undefined || v === null ? String(v) : `a ${typeof v}`}, not a boolean: return true (pass) or false (fail), or throw`;

/** Run trials until the posterior decides or maxTrials is spent. `false`, a non-boolean or a thrown error is a failure; a thrown `NoAnswer` is an error. */
export async function runTrials(opts: LiveOptions, fn: Trial): Promise<LiveSummary> {
	let successes = 0;
	let failures = 0;
	let errors = 0;
	let lastError: string | undefined;
	let decision: Decision = "inconclusive";
	const confidence = opts.confidence ?? 0.95;
	if (opts.k !== undefined && (!Number.isInteger(opts.k) || opts.k < 1))
		throw new RangeError(`live: k=${opts.k} must be an integer of at least 1`);
	for (let trial = 0; trial < opts.maxTrials; trial++) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- trials run one at a time: the posterior decides after each one
			const ok: unknown = await fn({ trial });
			if (ok === true) successes++;
			else {
				failures++;
				if (ok !== false) lastError = notBoolean(ok);
			}
		} catch (e) {
			if (e instanceof NoAnswer) errors++;
			else failures++;
			lastError = e instanceof Error ? e.message : String(e);
		}
		if (successes + failures < (opts.minTrials ?? 1)) continue;
		decision = decide(successes, failures, opts.threshold, confidence);
		if (decision !== "inconclusive") break;
	}
	const trials = successes + failures;
	return {
		decision,
		trials,
		errors,
		successes,
		failures,
		passRate: trials > 0 ? successes / trials : 0,
		...(opts.k !== undefined && trials >= opts.k ? { passHatK: passHatK(trials, successes, opts.k) } : {}),
		probability: posteriorAbove(successes, failures, opts.threshold),
		threshold: opts.threshold,
		stoppedEarly: decision !== "inconclusive" && trials < opts.maxTrials,
		lastError,
	};
}

export const liveEnabled = (): boolean => process.env.TESTKIT_LIVE === "1";

/** A paid, statistical test: skipped (with a reason) unless TESTKIT_LIVE=1 or `force`. Fails on `fail`; `inconclusive` fails too. */
export function live(name: string, opts: LiveOptions, fn: Trial): void {
	test(name, async (ctx: TestContext): Promise<void> => {
		if (!opts.force && !liveEnabled()) return ctx.skip("live test: set TESTKIT_LIVE=1 to run");
		const summary = await runTrials(opts, fn);
		(ctx.task.meta as Record<string, unknown>).live = summary;
		if (summary.decision !== "pass")
			throw new Error(
				`live ${summary.decision}: ${summary.successes}/${summary.trials} passed, P(rate>${opts.threshold})=${summary.probability.toFixed(3)}${summary.lastError ? `; last error: ${summary.lastError}` : ""}`,
			);
	});
}
