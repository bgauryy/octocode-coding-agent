// The result of a background `bash` start: the model's text, structured output and details.
import { formatDuration } from "../../shared/format.ts";
import type { BashJob, VerificationReceipt } from "../bash-jobs/types.ts";
import { jobLines } from "./results.ts";
import { verificationJson, verificationLine } from "./verification.ts";

export function backgroundStarted(job: BashJob, cwd: string, verification: VerificationReceipt | undefined) {
	const timeout = job.timeout;
	const text = [
		`Started ${job.id} in the background (pid ${job.pid}${timeout ? `, stopped after ${formatDuration(timeout * 1000)}` : ""}). Keep working: its exit status and output tail arrive as a message.`,
		...jobLines(job, cwd),
		...(verification ? [verificationLine(verification)] : []),
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
			...(verification ? { verification, notices: [verificationLine(verification)] } : {}),
		},
	};
}
