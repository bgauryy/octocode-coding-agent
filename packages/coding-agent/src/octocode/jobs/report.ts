import type { AgentToolResult } from "@octocodeai/octocode-agent-core";
import { cutText } from "@octocodeai/octocode-common/text";
import type { Job, JobOutcome } from "./async-jobs.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { contentText } from "../shared/util.ts";

/**
 * The report of a tool call that became a job: the model reads `taskReport`'s text; the terminal draws the row from
 * `TaskDetails` (`jobs/render.ts`).
 */

/** What the report's details carry. */
export interface TaskDetails {
	id: string;
	tool: string;
	title: string;
	/** What happened: `finished`, `failed`, `stopped (user)`. */
	how: string;
	ok: boolean;
	/** The user or the session stopped it, which is not a failure. */
	interrupted?: true;
	seconds: number;
	why?: string;
}

const TITLE_CHARS = 120;

/** A call in a few words for a row and a report: one line, clipped. */
export function taskTitle(text: string): string {
	return cutText(text.replace(/\s+/g, " ").trim(), TITLE_CHARS, { chars: true });
}

export function taskDetails(job: Job, outcome: JobOutcome): TaskDetails {
	const seconds = Math.round(outcome.durationMs / 100) / 10;
	const failed = outcome.kind === "failed" || (outcome.kind === "done" && isErrorResult(outcome.value));
	const how = outcome.kind === "stopped" ? `stopped (${outcome.by})` : failed ? "failed" : "finished";
	return {
		id: job.id,
		tool: job.tool,
		title: job.title,
		how,
		ok: outcome.kind === "done" && !failed,
		...(outcome.kind === "stopped" ? { interrupted: true as const } : {}),
		seconds,
		...(job.reason?.trim() ? { why: taskTitle(job.reason) } : {}),
	};
}

function isErrorResult(value: unknown): boolean {
	return typeof value === "object" && value !== null && (value as { isError?: unknown }).isError === true;
}

/** The text a finished job hands the model: a status line, the call, then what the work returned or why it failed. */
export function taskReport(job: Job, outcome: JobOutcome): string {
	const details = taskDetails(job, outcome);
	const head = `[${job.id} · ${job.tool} ${details.how} after ${details.seconds}s]\n${job.title}`;
	if (outcome.kind === "stopped") return head;
	if (outcome.kind === "failed") return `${head}\nError: ${errorMessage(outcome.error)}`;
	const result = outcome.value as AgentToolResult<unknown> | undefined;
	const text = result ? contentText(result.content) : "";
	return text ? `${head}\n${text}` : head;
}

/** The reply of a call whose work went on as a job. */
export function jobStartedText(job: Job, foregroundMs: number): string {
	const seconds = Math.round(foregroundMs / 1000);
	return `${job.tool} is still running after ${seconds}s: job ${job.id} (${job.title}). Its result arrives as a message when it ends; do other work meanwhile and do not poll it.`;
}
