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
	probability: number;
	threshold: number;
	stoppedEarly: boolean;
	lastError?: string;
}

export type Trial = (info: { trial: number }) => Promise<boolean | void> | boolean | void;

/** Run trials until the posterior decides or maxTrials is spent. `false` or a thrown error is a failure; a thrown `NoAnswer` is an error. */
export async function runTrials(opts: LiveOptions, fn: Trial): Promise<LiveSummary> {
	let successes = 0;
	let failures = 0;
	let errors = 0;
	let lastError: string | undefined;
	let decision: Decision = "inconclusive";
	const confidence = opts.confidence ?? 0.95;
	for (let trial = 0; trial < opts.maxTrials; trial++) {
		try {
			const ok = await fn({ trial });
			if (ok === false) failures++;
			else successes++;
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
		probability: posteriorAbove(successes, failures, opts.threshold),
		threshold: opts.threshold,
		stoppedEarly: decision !== "inconclusive" && trials < opts.maxTrials,
		lastError,
	};
}

export const liveEnabled = (): boolean => process.env.TESTKIT_LIVE === "1";

/** A paid, statistical test: skipped (with a reason) unless TESTKIT_LIVE=1 or `force`. Fails on `fail`; `inconclusive` fails too. */
export function live(name: string, opts: LiveOptions, fn: Trial): void {
	test(name, async (ctx: TestContext) => {
		if (!opts.force && !liveEnabled()) return ctx.skip("live test: set TESTKIT_LIVE=1 to run");
		const summary = await runTrials(opts, fn);
		(ctx.task.meta as Record<string, unknown>).live = summary;
		if (summary.decision !== "pass")
			throw new Error(
				`live ${summary.decision}: ${summary.successes}/${summary.trials} passed, P(rate>${opts.threshold})=${summary.probability.toFixed(3)}${summary.lastError ? `; last error: ${summary.lastError}` : ""}`,
			);
	});
}
