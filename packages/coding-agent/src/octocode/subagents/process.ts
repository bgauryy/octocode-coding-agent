import { envInt } from "../../../../common/src/env.ts";
import { getCliInvocation } from "../../config.ts";
import { STARTUP_RETRY_DELAY_MS, StartupError, type SubagentOutcome } from "./process/outcome.ts";
import { runChild } from "./process/run-child.ts";
import type { ChildRun } from "./process/run-phase.ts";

/** Seconds (0-600) a child that keeps crashing while loading its code is started again for. */
export const STARTUP_RETRY_ENV = "OCTOCODE_SUBAGENT_STARTUP_RETRY_SECONDS";

/**
 * The default of `STARTUP_RETRY_ENV` for a child that runs the source tree: long enough to outlast a peer's edit that
 * leaves a file half-saved for a while (several saves, a formatter run). A bundled child gets no extra starts: its
 * code does not change under it, so the one retry below is all a second start can fix.
 */
const SOURCE_STARTUP_RETRY_MS = 30_000;

/** Whether a child started with `prefix` loads TypeScript source (`src/cli.ts` through the source resolver). */
const runsSource = (prefix: readonly string[]): boolean => prefix.some((arg) => /\.[cm]?ts$/.test(arg));

/** How long, in total, the starts after the first one may wait: `STARTUP_RETRY_ENV`, else the default for the child's entry. */
function startupRetryBudgetMs(prefix: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
	const seconds = envInt(env, STARTUP_RETRY_ENV, -1, { max: 600 });
	if (seconds >= 0) return seconds * 1000;
	return runsSource(prefix) ? SOURCE_STARTUP_RETRY_MS : 0;
}

/** Resolves after `ms`, or early when `signal` aborts (a user stop must not wait out the delay). */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

/**
 * Runs one child (see `runChild`). A child that crashed while loading its code before any model turn ran no tool, so
 * starting it again repeats nothing: it is started once more after `STARTUP_RETRY_DELAY_MS`, then again, the wait
 * doubling each time, while the waits fit `startupRetryBudgetMs`. When the budget is spent the last error stands.
 * A stop (`signal`) is never retried and ends a wait at once.
 */
export async function runSubagent(run: ChildRun): Promise<SubagentOutcome> {
	const { signal } = run;
	const budget = startupRetryBudgetMs(getCliInvocation().prefix);
	let waited = 0;
	let delay = STARTUP_RETRY_DELAY_MS;
	for (;;) {
		try {
			return await runChild(run);
		} catch (error) {
			if (!(error instanceof StartupError) || !error.retryable || signal?.aborted) throw error;
			const left = budget - waited;
			if (waited > 0 && left <= 0) throw error;
			const wait = waited === 0 ? delay : Math.min(delay, left);
			await pause(wait, signal);
			if (signal?.aborted) throw new Error("Subagent cancelled", { cause: error });
			waited += wait;
			delay *= 2;
		}
	}
}
