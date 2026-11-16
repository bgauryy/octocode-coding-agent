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
import { JOB_WHY_PREFIX, jobWhy } from "./message.ts";

/** The report a finished job sends: how it ended and the tail of its log (its text format: `message.ts`). */

/** The first line of a report, shaped like a foreground result's: `[exit 1 · 61s · 48,213 lines · 2.1 MB · log: <path>]`. */
function jobHeader(job: BashJob, exit: JobExit, lines: number): string {
	const status =
		job.stopped === "timeout"
			? `timed out after ${job.timeout ?? 0}s`
			: job.stopped
				? `stopped (${job.stopped})`
				: exit.code !== null
					? `exit ${exit.code}`
					: `signal ${exit.signal ?? "unknown"}`;
	let bytes = 0;
	try {
		bytes = fs.statSync(job.log).size;
	} catch {
		// The log is unavailable; the report says so.
	}
	const size =
		lines === 0 && bytes === 0
			? "no output"
			: `${formatCount(lines)} ${lines === 1 ? "line" : "lines"} · ${formatBytes(bytes, "spaced")}`;
	return `[${[status, `${exit.seconds}s`, size, `log: ${shortPath(job.log, job.cwd)}`].join(" · ")}]`;
}

/**
 * The details of a job's report message; `quiet` when it starts no turn (read by `subagents/report.ts` `jobNotice`). The
 * `command` lets provenance index the output as the foreground result of that command would be
 * (`permission/provenance/reports.ts`).
 */
export function jobDetails(job: BashJob, wake: boolean) {
	return {
		id: job.id,
		command: job.command,
		log: job.log,
		...(job.verification ? { verification: job.verification } : {}),
		...(wake ? {} : { quiet: true as const }),
	};
}

/** The message a finished job sends: a status header, how it ended, and the tail of its output. */
export function jobReport(job: BashJob, exit: JobExit): string {
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
		jobHeader(job, exit, lines),
		`Background bash ${job.id} ${how} after ${formatDuration(exit.seconds * 1000)}: ${cutText(firstLine(job.command), 120, { chars: true })}`,
		jobWhy(job) ? `${JOB_WHY_PREFIX}${jobWhy(job)}` : "",
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
