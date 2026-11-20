// The result of a background `bash` start: the model's text, structured output and details.
import { formatDuration } from "../../shared/format.ts";
import type { BashJob, VerificationReceipt } from "../bash-jobs/types.ts";
import type { JobRow } from "../../../../../db/src/api.ts";
import { joinedText } from "../bash-jobs/joins.ts";
import { jobLines } from "./results.ts";
import { verificationJson, verificationText } from "./verification.ts";

export function backgroundStarted(job: BashJob, cwd: string, verification: VerificationReceipt | undefined) {
	const timeout = job.timeout;
	const text = [
		`Started ${job.id} in the background (pid ${job.pid}${timeout ? `, will be stopped if still running after ${formatDuration(timeout * 1000)}` : ""}). Keep working: its exit status and output tail arrive as a message.`,
		...jobLines(job, cwd),
		...(verification ? [verificationText(verification)].filter(Boolean) : []),
	].join("\n");
	return {
		content: [{ type: "text" as const, text }],
		structuredContent: {
			job: job.id,
			pid: job.pid,
			log: job.log,
			...(verification ? { verification: verificationJson(verification) } : {}),
		},
		details: {
			job: job.id,
			pid: job.pid,
			log: job.log,
			...(verification ? { verification, notices: [verificationText(verification)].filter(Boolean) } : {}),
		},
	};
}

/** The reply of a background start that joined a running identical job: nothing was started. */
export function backgroundJoined(row: JobRow, cwd: string, now: number) {
	const text = joinedText(row, cwd, now);
	return {
		content: [{ type: "text" as const, text }],
		structuredContent: { job: row.job, pid: row.pid, log: row.log, joined: true },
		details: { job: row.job, pid: row.pid, log: row.log, joined: true },
	};
}
