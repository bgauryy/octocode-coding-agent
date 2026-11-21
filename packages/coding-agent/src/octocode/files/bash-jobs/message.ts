import { cutText } from "@octocodeai/octocode-common/text";
import type { BashJob } from "./types.ts";

/**
 * A finished job's report message: the model reads its text (`report.ts` `jobReport`: a status header
 * `[… · log: <path>]`, the `Background bash <id> <how>: <command>` line, then how it ended and the output tail), and
 * the terminal reads its details (`JobEnd` beside `id`, `command` and `log`; `files/render.ts` `renderJobMessage`). Older
 * reports state the duration in the line, the reason in a `Why: <reason>` line and the log in a `Log: <path>` line,
 * and carry no `JobEnd`: `parseJobMessage` still reads them.
 */

/** How a job ended, as its report's details carry it: the TUI draws the row from these, not from the text. */
export interface JobEnd {
	/** What happened: `finished`, `failed with exit code 1`, `stopped (user)`. */
	how: string;
	/** It exited with status 0. */
	ok: boolean;
	/** The user or the session stopped it, which is not a failure (a timeout is). */
	interrupted?: true;
	seconds: number;
	/** The reason the job ran, clipped; absent when the call gave none. */
	why?: string;
}

/** The `JobEnd` fields of `details`, or undefined for a report written without them. */
export function readJobEnd(details: unknown): JobEnd | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const { how, ok, interrupted, seconds, why } = details as Record<string, unknown>;
	if (typeof how !== "string" || typeof ok !== "boolean" || typeof seconds !== "number") return undefined;
	return {
		how,
		ok,
		seconds,
		...(interrupted === true ? { interrupted } : {}),
		...(typeof why === "string" && why ? { why } : {}),
	};
}

/** Longest job reason a report or listing repeats; the call that started the job holds the whole text. */
const WHY_CHARS = 200;

/** Starts the report line naming the job's reason in reports written before `JobEnd`. */
const JOB_WHY_PREFIX = "Why: ";

/** The job's reason on one line, clipped; empty when the call gave none. */
export function jobWhy(job: Pick<BashJob, "reason">): string {
	const why = job.reason?.replace(/\s+/g, " ").trim();
	return why ? cutText(why, WHY_CHARS, { chars: true }) : "";
}

/** `<indent>why: <reason>` and a newline for a listing entry, or nothing without a reason. */
export function jobWhyLine(job: Pick<BashJob, "reason">, indent: string): string {
	const why = jobWhy(job);
	return why ? `${indent}why: ${why}\n` : "";
}

/** A report split into its `Background bash …` line, the reason and log an older one carries, and the lines after them. */
export function parseJobMessage(text: string): { head: string; why?: string; log?: string; rest: string[] } {
	const [head = "", ...rest] = text.replace(/^\[[^\n]*\]\n/, "").split("\n");
	const why = rest[0]?.startsWith(JOB_WHY_PREFIX) ? rest.shift()!.slice(JOB_WHY_PREFIX.length) : undefined;
	const log =
		/^\[[^\n]*· log: ([^\n]+)\]\n/.exec(text)?.[1] ??
		(rest[0]?.startsWith("Log: ") ? rest.shift()!.slice(5) : undefined);
	return { head, why, log, rest };
}
