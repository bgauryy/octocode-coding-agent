import fs from "node:fs";
import path from "node:path";
import { formatDuration } from "../../shared/format.ts";
import { shortPath } from "../../../utils/display-path.ts";
import { plural } from "../../shared/text.ts";
import type { BashJob, VerificationReceipt } from "../bash-jobs/types.ts";
import type { OrphanJob } from "../bash-jobs/records.ts";
import { moveFile } from "../../shared/sweep.ts";
import { firstLine } from "../../shared/util.ts";
import type { BashDetails } from "../outcome.ts";
import { verificationJson, verificationLine, verificationText } from "./verification.ts";
import { BashExecutionError } from "../../../core/tools/bash/outcome.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { RERUN_HINT } from "../outcome.ts";
import { PRIVATE_FILE_MODE } from "@octocodeai/octocode-common/file-mode";
import { cutText } from "@octocodeai/octocode-common/text";

/** Deadlines of foreground commands and the text `bash` returns about moved and orphaned jobs. */

/** The two lines that say where a background job logs and how to stop it. */
export function jobLines(job: BashJob, cwd: string): string[] {
	return [`Log: ${shortPath(job.log, cwd)}`, `Stop: kill -- -${job.pid}`];
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
	return { text: text.split(from).join(to), path: to };
}

/** The longest a foreground command may hold a turn, in seconds; a longer one belongs in the background. */
export const MAX_FOREGROUND_TIMEOUT = 60 * 60;

/** What the result says when a foreground timeout was cut to `MAX_FOREGROUND_TIMEOUT`. */
export const CLAMP_NOTE = `timeout clamped to ${MAX_FOREGROUND_TIMEOUT} s; use background: true for longer`;

/** What the result says when the background threshold, not the call's own timeout, moved the command. */
const AUTO_NOTE = "foreground commands move to the background after the configured threshold";

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
 * bounded command output, without host status lines), then where it runs and how to stop it.
 */
function movedResult(
	output: string,
	job: BashJob,
	seconds: number,
	clamped: boolean,
	cwd: string,
	fullOutputPath?: string,
	verification?: VerificationReceipt,
	how: "deadline" | "threshold" | "message" | "cap" = "deadline",
) {
	const lead =
		how === "message"
			? `A message for you is waiting, so this command (running ${formatDuration(Date.now() - job.startedAt)}) moved to the background as ${job.id} (pid ${job.pid}), still running. Answer the message; its exit status and output tail arrive as a message.`
			: `Did not finish within ${formatDuration(seconds * 1000)}; moved to the background as ${job.id} (pid ${job.pid}), still running. Its exit status and output tail arrive as a message.`;
	const moved = [
		lead,
		...jobLines(job, cwd),
		...(fullOutputPath ? [`Output so far, in full: ${fullOutputPath}`] : []),
	].join("\n");
	const threshold =
		how === "threshold"
			? `(${AUTO_NOTE}; pass a timeout to wait in the foreground and stop the command then)`
			: how === "cap"
				? `(a foreground wait lasts at most 10 minutes${job.timeout ? `; the job is stopped after ${formatDuration(job.timeout * 1000)} more` : ""})`
				: "";
	const text = [
		output.trimEnd(),
		moved,
		verification ? verificationText(verification) : "",
		threshold,
		clamped ? `(${CLAMP_NOTE})` : "",
	]
		.filter((part) => part !== "")
		.join("\n\n");
	const details: BashDetails = {
		job: job.id,
		pid: job.pid,
		log: job.log,
		moved: true,
		notices: [verification ? verificationLine(verification) : "", threshold, clamped ? `(${CLAMP_NOTE})` : ""].filter(
			Boolean,
		),
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

/** Preserve command facts when adding native timeout hints or adopting a still-running process. */
export function foregroundFailure(
	error: unknown,
	options: {
		spilled?: string;
		dir: string;
		adopted?: BashJob;
		seconds: number;
		clamped: boolean;
		cwd: string;
		verification?: VerificationReceipt;
		how: "deadline" | "threshold" | "message" | "cap";
	},
) {
	const full = adoptFullOutput(errorMessage(error), options.spilled, options.dir);
	const failure = error instanceof BashExecutionError ? error : undefined;
	const details = { ...failure?.details, ...(full.path ? { fullOutputPath: full.path } : {}) };
	const output = failure?.outputText ?? "";
	const adoptedOutput = full.path && options.spilled ? output.split(options.spilled).join(full.path) : output;
	if (options.adopted)
		return movedResult(
			adoptedOutput,
			options.adopted,
			options.seconds,
			options.clamped,
			options.cwd,
			full.path,
			options.verification,
			options.how,
		);
	if (failure?.details.termination !== "timeout") {
		const text = options.clamped ? `${full.text}\n\n(${CLAMP_NOTE})` : full.text;
		if (options.clamped) details.notices = [...(details.notices ?? []), `(${CLAMP_NOTE})`];
		throw failure ? new BashExecutionError(text, details) : new Error(text);
	}
	if (options.how === "message") {
		const note = `The wait ended early after ${formatDuration((failure.details.timeoutSeconds ?? 0) * 1000)} because a message is waiting for you: the sleep did not complete and was stopped. Answer the message; repeat the wait afterwards if it is still needed.`;
		details.notices = [...(details.notices ?? []), note];
		throw new BashExecutionError([output.trimEnd(), note].filter(Boolean).join("\n\n"), details);
	}
	const how = options.clamped
		? `with background: true and check its log (${CLAMP_NOTE})`
		: "with a longer timeout, or with background: true and check its log";
	const hint = `${RERUN_HINT} ${how}; if it waits for input, pass the input or a non-interactive flag.`;
	details.notices = [...(details.notices ?? []), hint];
	throw new BashExecutionError(`${full.text.trimEnd()}\n\n${hint}`, details);
}

/** The notice for jobs found running after their Octocode died (`reapOrphanJobs`). */
export function orphanNotice(orphans: readonly OrphanJob[]): string {
	const line = (job: OrphanJob) =>
		`  ${job.id} · pid ${job.pid} · ${cutText(firstLine(job.command), 80, { chars: true })}\n    log: ${shortPath(job.log)}`;
	const stopped = orphans.filter((job) => job.stopped);
	const unsure = orphans.filter((job) => !job.stopped);
	return [
		...(stopped.length
			? [
					`Stopped ${plural(stopped.length, "background bash job")} left running by an Octocode that exited without ending ${stopped.length === 1 ? "it" : "them"}:`,
					...stopped.map(line),
				]
			: []),
		...(unsure.length
			? [
					`Left alone, since they could not be confirmed as these jobs (the pid may belong to another process now): ${plural(unsure.length, "background bash job")} of an Octocode that exited; stop one yourself with kill -- -<pid> if it is still the job:`,
					...unsure.map(line),
				]
			: []),
	].join("\n");
}
