import fs from "node:fs";
import { formatCount } from "../../../core/tools/bash/header.ts";
import { formatBytes } from "@octocodeai/octocode-common/bytes";
import { formatDuration } from "../../shared/format.ts";
import { shortPath } from "../../../utils/display-path.ts";
import { visibleControls, withoutColors } from "@octocodeai/octocode-common/sanitize";
import { firstLine } from "../../shared/util.ts";
import type { BashJob, JobExit } from "./types.ts";
import { verificationText } from "../bash/verification.ts";
import { cutText } from "@octocodeai/octocode-common/text";
import { logTail } from "./tail.ts";
import { type JobEnd, jobWhy } from "./message.ts";

/** The longest command the report line repeats; `details.command` holds all of it. */
const COMMAND_CHARS = 60;

/** The report a finished job sends: how it ended and the tail of its log (its text format: `message.ts`). */

/**
 * The first line of a report, shaped like a foreground result's: `[exit 1 · 61s · log: <path>]`. Line and byte counts
 * (`· 48,213 lines · 2.1 MB`) come only when the tail leaves lines out (`lines` is the log's count then); a tail that
 * shows the whole log needs none.
 */
function jobHeader(job: BashJob, exit: JobExit, lines: number, trimmed: boolean): string {
	const status =
		job.stopped === "timeout"
			? `timed out after ${job.timeout ?? 0}s`
			: job.stopped
				? `stopped (${job.stopped})`
				: exit.code !== null
					? `exit ${exit.code}`
					: `signal ${exit.signal ?? "unknown"}`;
	let size: string[] = [];
	if (trimmed) {
		let bytes = 0;
		try {
			bytes = fs.statSync(job.log).size;
		} catch {
			// The log is unavailable; the report says so.
		}
		size = [`${formatCount(lines)} ${lines === 1 ? "line" : "lines"}`, formatBytes(bytes, "spaced")];
	}
	return `[${[status, `${exit.seconds}s`, ...size, `log: ${shortPath(job.log, job.cwd)}`].join(" · ")}]`;
}

/** How a job ended, in words: `finished`, `failed with exit code 2`, `stopped (user)`. */
function jobOutcome(job: BashJob, exit: JobExit): Pick<JobEnd, "how" | "ok" | "interrupted"> {
	const how =
		job.stopped === "timeout"
			? `stopped after its ${formatDuration((job.timeout ?? 0) * 1000)} timeout`
			: job.stopped
				? `stopped (${job.stopped})`
				: exit.code === 0
					? "finished"
					: exit.code !== null
						? `failed with exit code ${exit.code}`
						: `ended by ${exit.signal ?? "an error"}`;
	return {
		how,
		ok: !job.stopped && exit.code === 0,
		...(job.stopped && job.stopped !== "timeout" ? { interrupted: true as const } : {}),
	};
}

/**
 * The details of a job's report message; `quiet` when it starts no turn (read by `subagents/report.ts` `jobNotice`). The
 * `command` lets provenance index the output as the foreground result of that command would be
 * (`permission/provenance/reports.ts`).
 */
export function jobDetails(job: BashJob, exit: JobExit, wake: boolean) {
	const why = jobWhy(job);
	return {
		id: job.id,
		command: job.command,
		log: job.log,
		...jobOutcome(job, exit),
		seconds: exit.seconds,
		...(why ? { why } : {}),
		...(job.verification ? { verification: job.verification } : {}),
		...(wake ? {} : { quiet: true as const }),
	};
}

/** The message a finished job sends: a status header, how it ended, and the tail of its output. */
export function jobReport(job: BashJob, exit: JobExit): string {
	const { how } = jobOutcome(job, exit);
	const available = fs.existsSync(job.log);
	const { text, earlier } = logTail(job.log);
	// Logs hold raw terminal output. Colors are dropped (as Octocode's bash does; the log keeps them); every other control
	// character shows as a visible escape, so nothing is hidden from the model.
	const tail = visibleControls(withoutColors(text)).trimEnd();
	const before = earlier > 0 ? `[+${earlier} earlier line${earlier === 1 ? "" : "s"} in the log]` : "";
	const stopped = exit.logStopped
		? `log stopped at ${exit.logStopped.bytes} bytes: ${exit.logStopped.error}; later output was not recorded`
		: "";
	// Rotation keeps one older file: the first rotation leaves the earlier output in `.1`, a later one replaces it.
	const archived = job.verification?.output.archiveAvailable ?? fs.existsSync(`${job.log}.1`);
	const rotated = exit.logRotations
		? `log rotated at its size cap${exit.logRotations > 1 ? ` ${exit.logRotations} times` : ""}: ${shortPath(`${job.log}.1`, job.cwd)} ${archived ? "holds the part before this log" : "is unavailable; earlier output cannot be recovered"}${exit.logRotations > 1 ? "; output before that was dropped and cannot be recovered" : ""}`
		: "";
	const lines = earlier + (tail ? tail.split("\n").length : 0);
	return [
		jobHeader(job, exit, lines, earlier > 0),
		`Background bash ${job.id} ${how}: ${cutText(firstLine(job.command), COMMAND_CHARS, { chars: true })}`,
		job.verification ? verificationText(job.verification) : "",
		!available ? "Log unavailable; output could not be inspected" : "",
		rotated,
		stopped,
		before,
		tail || (before ? "" : "(no output)"),
	]
		.filter(Boolean)
		.join("\n");
}
