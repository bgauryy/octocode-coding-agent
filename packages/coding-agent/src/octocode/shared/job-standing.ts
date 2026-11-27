import os from "node:os";
import { readRecord, recordFile } from "./job-records.ts";
import { groupAlive, processAlive } from "./process.ts";

/** The fields of a `jobs` row this module reads; the database's own row type satisfies it. */
export interface JobRowView {
	pid: number;
	host: string | null;
	log: string;
	state: "running" | "finished" | "stopped";
	exit_code: number | null;
}

/**
 * Whether the job a row names still runs here: its owner record (private, written by the Octocode that owns the job) names
 * the same process, that process group is alive and so is the Octocode that owns it. The row alone proves nothing.
 */
export function ownerAlive(row: Pick<JobRowView, "pid" | "log" | "host">): boolean {
	if (row.host !== null && row.host !== os.hostname()) return false;
	const record = readRecord(recordFile(row.log));
	return record !== undefined && record.pid === row.pid && groupAlive(record.pid) && processAlive(record.owner.pid);
}

/** Where a job stands for something that waits on it: running, ended well, ended badly (`why`) or unknown. */
export type JobStanding =
	| { state: "running" }
	| { state: "done" }
	| { state: "failed"; why: string }
	| { state: "missing" };

/** The standing a job's row gives; a row still `running` whose owner is gone is failed: nothing recorded its end. */
export function jobStandingOf(row: JobRowView | undefined): JobStanding {
	if (!row) return { state: "missing" };
	if (row.state === "running")
		return ownerAlive(row) ? { state: "running" } : { state: "failed", why: "ended without recording how" };
	if (row.state === "stopped") return { state: "failed", why: "was stopped" };
	return row.exit_code === 0
		? { state: "done" }
		: { state: "failed", why: `exited ${row.exit_code ?? "without a code"}` };
}
