import fs from "node:fs";
import path from "node:path";
import { formatDuration, shortPath } from "../../shared/format.ts";
import { PRIVATE_FILE_MODE } from "../../shared/home.ts";
import { plural } from "../../shared/render.ts";
import { moveFile } from "../../shared/sweep.ts";
import { firstLine } from "../../shared/util.ts";
import type { BashJob, OrphanJob } from "../bash-jobs.ts";
import type { BashDetails } from "../render.ts";
import { type VerificationReceipt, verificationJson, verificationLine } from "./verification.ts";

/** Deadlines of foreground commands and the text `bash` returns about moved and orphaned jobs. */

/** The three lines that say where a background job logs and how to check and stop it. */
export function jobLines(job: BashJob, cwd: string): string[] {
	const log = shortPath(job.log, cwd);
	return [`Log: ${log}`, `Check: tail -n 40 ${log}`, `Stop: kill -- -${job.pid}`];
}

/** Deadline of a foreground command whose call names none, in seconds. */
export const DEFAULT_BASH_TIMEOUT = 15 * 60;

/**
 * Octocode writes a truncated command's full output (`from`, its `details.fullOutputPath`) to the OS temp directory; move it
 * under `dir` and point `text` at the new path. Unchanged when the move fails.
 */
export function adoptFullOutput(text: string, from: string | undefined, dir: string): { text: string; path?: string } {
	if (!from || path.dirname(from) === dir || !fs.existsSync(from)) return { text };
	const to = path.join(dir, path.basename(from));
	if (fs.existsSync(to)) return { text };
	if (!moveFile(from, to)) return { text };
	fs.chmodSync(to, PRIVATE_FILE_MODE);
	return { text: text.split(from).join(shortPath(to)), path: to };
}

/** The longest a foreground command may hold a turn, in seconds; a longer one belongs in the background. */
export const MAX_FOREGROUND_TIMEOUT = 60 * 60;

/** What the result says when a foreground timeout was cut to `MAX_FOREGROUND_TIMEOUT`. */
export const CLAMP_NOTE = `timeout clamped to ${MAX_FOREGROUND_TIMEOUT} s; use background: true for longer`;

/** The timeout a foreground call runs with: what it asked for (at most `MAX_FOREGROUND_TIMEOUT`), else `DEFAULT_BASH_TIMEOUT`. */
export function effectiveTimeout(requested: unknown): { seconds: number; clamped: boolean } {
	if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0)
		return { seconds: DEFAULT_BASH_TIMEOUT, clamped: false };
	return requested > MAX_FOREGROUND_TIMEOUT
		? { seconds: MAX_FOREGROUND_TIMEOUT, clamped: true }
		: { seconds: requested, clamped: false };
}

/**
 * The result of a foreground command that reached its deadline and went on as `job`: the output it had printed (the
 * message Octocode's bash built for the timeout, less its status line), then where it runs and how to stop it.
 */
export function movedResult(
	message: string,
	job: BashJob,
	seconds: number,
	clamped: boolean,
	cwd: string,
	fullOutputPath?: string,
	verification?: VerificationReceipt,
) {
	const output = message.replace(/(?:^|\n\n)Command timed out after [\d.]+ seconds$/, "").trimEnd();
	const moved = [
		`Did not finish within ${formatDuration(seconds * 1000)}; moved to the background as ${job.id} (pid ${job.pid}), still running. Its exit status and output tail arrive as a message.`,
		...jobLines(job, cwd),
	].join("\n");
	const text = [output, moved, verification ? verificationLine(verification) : "", clamped ? `(${CLAMP_NOTE})` : ""]
		.filter((part) => part !== "")
		.join("\n\n");
	const details: BashDetails = {
		job: job.id,
		pid: job.pid,
		log: job.log,
		moved: true,
		...(verification ? { verification } : {}),
		...(fullOutputPath ? { fullOutputPath } : {}),
	};
	return {
		content: [{ type: "text" as const, text }],
		structuredContent: {
			job: job.id,
			pid: job.pid,
			log: job.log,
			...(verification ? { verification: verificationJson(verification) } : {}),
		},
		details,
	};
}

/** The notice for jobs found running after their Octocode died (`reapOrphanJobs`). */
export function orphanNotice(orphans: readonly OrphanJob[]): string {
	const line = (job: OrphanJob) =>
		`  ${job.id} · pid ${job.pid} · ${firstLine(job.command).slice(0, 80)}\n    log: ${shortPath(job.log)}`;
	const stopped = orphans.filter((job) => job.stopped);
	const unsure = orphans.filter((job) => !job.stopped);
	return [
		...(stopped.length
			? [
					`Stopped ${plural(stopped.length, "background bash job")} left running by a Octocode that exited without ending ${stopped.length === 1 ? "it" : "them"}:`,
					...stopped.map(line),
				]
			: []),
		...(unsure.length
			? [
					`Left alone, since they could not be confirmed as these jobs (the pid may belong to another process now): ${plural(unsure.length, "background bash job")} of a Octocode that exited; stop one yourself with kill -- -<pid> if it is still the job:`,
					...unsure.map(line),
				]
			: []),
	].join("\n");
}
