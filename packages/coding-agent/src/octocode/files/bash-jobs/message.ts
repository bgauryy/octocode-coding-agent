import { cutText } from "@octocodeai/octocode-common/text";
import type { BashJob } from "./types.ts";

/**
 * The text of a finished job's report message, written by `report.ts` `jobReport` and read back by `files/render.ts`
 * `renderJobMessage`: a status header `[… · log: <path>]`, the `Background bash <id> <how>: <command>` line, an
 * optional `Why: <reason>` line, then how it ended and the output tail. Older reports carry a `Log: <path>` line
 * instead of the header's log.
 */

/** Longest job reason a report or listing repeats; the call that started the job holds the whole text. */
const WHY_CHARS = 200;

/** Starts the report line naming the job's reason. */
export const JOB_WHY_PREFIX = "Why: ";

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

/** A report split into its `Background bash …` line, its reason and log when present, and the lines after them. */
export function parseJobMessage(text: string): { head: string; why?: string; log?: string; rest: string[] } {
	const [head = "", ...rest] = text.replace(/^\[[^\n]*\]\n/, "").split("\n");
	const why = rest[0]?.startsWith(JOB_WHY_PREFIX) ? rest.shift()!.slice(JOB_WHY_PREFIX.length) : undefined;
	const log =
		/^\[[^\n]*· log: ([^\n]+)\]\n/.exec(text)?.[1] ??
		(rest[0]?.startsWith("Log: ") ? rest.shift()!.slice(5) : undefined);
	return { head, why, log, rest };
}
