import type { BashJobs } from "../../../files/bash-jobs.ts";
import type { WorkRow } from "../../../shared/running-work.ts";

/** The running jobs as the footer's typed counts and the work rows above it (`team/panel.ts`). */
export function jobWorkRows(jobs: BashJobs): WorkRow[] {
	return [...jobs.jobs.values()].map((job): WorkRow => {
		const command = job.command.trim().split("\n", 1)[0] ?? "";
		const reason = job.reason?.trim();
		return {
			kind: "bash",
			id: job.id,
			title: reason || command,
			...(reason && command ? { detail: command } : {}),
			startedAt: job.startedAt,
			...(job.item ? { item: job.item } : {}),
		};
	});
}
