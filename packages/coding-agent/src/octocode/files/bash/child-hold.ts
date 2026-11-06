import { formatDuration } from "../../shared/format.ts";
import { firstLine, MINUTE_MS, settleWithin } from "../../shared/util.ts";
import type { BashJobs } from "../bash-jobs.ts";
import type { BashJob } from "../bash-jobs/types.ts";

/**
 * A subagent's run ends with its answer, and its jobs are stopped with it. A child that answers while a job it started
 * still runs is almost always waiting for that job ("I'll wait for the completion message"), so the run holds instead:
 * until the first of its jobs ends (its completion then goes to the model in one more turn), or for
 * `CHILD_JOB_HOLD_MS`, after which the child is told once which jobs still run and how they end. Answering again with
 * only those jobs left is its choice: the run then ends and stops them as before.
 */

/** How long a child's run holds after its answer for the first of its own running jobs to end. */
export const CHILD_JOB_HOLD_MS = 10 * MINUTE_MS;

/** `customType` of the note telling a child its jobs outlasted the hold. */
export const JOB_HOLD_TYPE = "octocode-job-hold";

/** The note for jobs still running after the hold. */
function jobHoldNote(jobs: readonly BashJob[], heldMs: number, now = Date.now()): string {
	const lines = jobs.map(
		(job) =>
			`- ${job.id} (pid ${job.pid}, running ${formatDuration(now - job.startedAt)}): ${firstLine(job.command).slice(0, 80)}; log ${job.log}`,
	);
	return [
		`Your run held ${formatDuration(heldMs)} after your answer, and these background jobs you started are still running:`,
		...lines,
		"Your run ends when you answer again, and they are stopped then. To wait longer, end your turn again: the run holds until one ends. Otherwise stop them, or say in your report that you leave them unfinished.",
	].join("\n");
}

/**
 * Holds a child's run for its own jobs. Resolves true when the model should get one more turn: a job ended (its report
 * is queued by the job's own exit) or the jobs outlasted the hold (`notify` got the note). False when nothing runs, the
 * child was already told about every running job, or `stop` fired.
 */
export async function holdForOwnJobs(
	jobs: Pick<BashJobs, "running">,
	warned: WeakSet<BashJob>,
	notify: (text: string) => void,
	stop: AbortSignal | undefined,
	holdMs = CHILD_JOB_HOLD_MS,
): Promise<boolean> {
	const running = jobs.running();
	const fresh = running.filter((job) => !warned.has(job));
	if (fresh.length === 0) return false;
	let ended = false;
	const started = Date.now();
	// A job's `done` resolves after its exit report was sent: the report is queued before this resumes.
	await settleWithin(
		Promise.race(running.map((job) => job.done)).then(() => {
			ended = true;
			return undefined;
		}),
		holdMs,
		stop,
	);
	if (stop?.aborted) return false;
	if (ended) return true;
	for (const job of fresh) warned.add(job);
	notify(jobHoldNote(fresh, Date.now() - started));
	return true;
}
