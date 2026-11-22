import type { RunningWork, WorkRow } from "../../shared/running-work.ts";
import { formatSpan } from "../../shared/format.ts";

/** What `/jobs` shows when nothing is running: how to start each kind. */
const EMPTY =
	"Nothing is running. Start a background job with bash (background: true), a notification with the notify tool, or a schedule with /loop <interval> <prompt>.";

/** How to end each kind, one dim line under the list. */
const CANCEL_HINT = "Cancel any row: /jobs kill <id>";

/** `#4 · cron every 5m · next in 3m · note`: a timer's row with the time left to its next wake or deadline. */
function timerLine(row: WorkRow, now: number): string {
	const left =
		row.dueAt === undefined
			? ""
			: ` · ${row.title.startsWith("until") ? "deadline" : "next"} in ${formatSpan(row.dueAt - now)}`;
	return `${row.id} · ${row.title}${left}${row.detail ? ` · ${row.detail}` : ""}`;
}

/**
 * Everything of this session that runs or waits, grouped: background bash jobs (`bashLines`, from `BashJobs.describe`),
 * then crons and waits from the timer rows `work` holds, each with its id and time to its next fire.
 */
export function jobsOverview(bashLines: string | undefined, work: RunningWork, now: number): string {
	const timers = work.all().filter((row) => row.kind === "timer");
	const crons = timers.filter((row) => row.title.startsWith("cron "));
	const waits = timers.filter((row) => !row.title.startsWith("cron "));
	const groups = [
		...(bashLines ? [`Background bash jobs\n${bashLines}`] : []),
		...(crons.length ? [`Crons\n${crons.map((row) => timerLine(row, now)).join("\n")}`] : []),
		...(waits.length ? [`Waits\n${waits.map((row) => timerLine(row, now)).join("\n")}`] : []),
	];
	return groups.length ? `${groups.join("\n\n")}\n\n${CANCEL_HINT}` : EMPTY;
}
