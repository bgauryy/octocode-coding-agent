import { type JobRow } from "../../../../../../db/src/api.ts";
import type { FeatureSetup } from "../../../../core/features/index.ts";
import { envFlag, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { sharedAgentDb } from "../../../../storage/database.ts";
import type { BashJobs } from "../../../files/bash-jobs.ts";
import { JobLedger } from "../../../files/bash-jobs/ledger.ts";
import { JoinWatch, joinedDetails, joinedReport } from "../../../files/bash-jobs/joins.ts";
import type { BashJob, JobExit } from "../../../files/bash-jobs/types.ts";
import { followerFor } from "../../../team/database-followers.ts";
import { JOB_TYPE } from "../../../shared/messages.ts";
import { wakeGateOf } from "../../../wake/gate.ts";

/** What a background start asks of the job rows. */
interface JoinRequest {
	command: string;
	cwd: string;
	/** Start a new run even if an identical one runs. */
	fresh?: boolean | undefined;
	/** A verification receipt belongs to the run it starts, so a call asking for one never joins. */
	verify?: boolean | undefined;
}

export interface BackgroundJoins {
	/** The running identical job this start joins, with this session registered for its exit; undefined: start a new run. */
	join(request: JoinRequest): JobRow | undefined;
	/** Writes the row of a job that just started. */
	record(job: BashJob, agent: string | undefined): void;
	/** Ends the row of a job that exited. */
	end(job: BashJob, exit: JobExit): void;
	stop(): void;
}

const joinedKey = (row: Pick<JobRow, "session_id" | "job">) => `${row.session_id}\u0000${row.job}`;

/** Resolvers of the joined jobs' `done`, by joined key. */
const ends = new WeakMap<BashJobs, Map<string, () => void>>();

/**
 * Background jobs as database rows and the joins they allow: an identical job (same workspace, folder and normalized
 * command) that runs with a live owner is joined instead of started again, and the joining session hears of its end like
 * a job of its own. A row never grants a signal over another session's process: `/jobs kill` acts on this session's jobs only.
 */
export function backgroundJoins(
	api: FeatureSetup,
	jobs: BashJobs,
	session: () => string,
	closing: () => boolean,
	warn: (text: string) => void,
): BackgroundJoins {
	const ledger = new JobLedger(() => sharedAgentDb(), session);
	const watch = new JoinWatch(
		ledger,
		(row, how) => {
			jobs.joined.delete(joinedKey(row));
			// Resolves once the report is queued, so a run held on this job finds it when it continues.
			const finish = ends.get(jobs)?.get(joinedKey(row));
			ends.get(jobs)?.delete(joinedKey(row));
			if (closing()) return finish?.();
			const wake = !envFlag(process.env, SUBAGENT_ENV);
			const exit = how === "owner gone" ? null : row.exit_code;
			const sending = wakeGateOf(api).emit(
				{
					kind: "job.exit",
					job: row.job,
					exit,
					durationMs: (row.ended_at ?? row.updated_at) - row.started_at,
					startedAt: row.started_at,
					log: row.log,
					...(row.state === "stopped" ? { stopped: true } : {}),
				},
				{
					customType: JOB_TYPE,
					content: joinedReport(row, how),
					display: true,
					details: joinedDetails(row, how, wake),
				},
				{ triggerTurn: wake, deliverAs: wake ? "steer" : "followUp", together: true },
			);
			void Promise.resolve(sending)
				.catch((error: unknown) => warn(`Joined job ${row.job} report failed: ${errorMessage(error)}`))
				.finally(() => finish?.());
		},
		(error) => warn(`Watching joined jobs stopped: ${errorMessage(error)}`),
		(poke) => followerFor(sharedAgentDb().file).subscribe(poke),
	);
	return {
		join(request) {
			if (request.fresh || request.verify) return undefined;
			const row = ledger.joinable(request.cwd, request.command);
			if (!row) return undefined;
			// A job of this session reports to it already; another session's is watched until its row ends.
			if (!(ledger.isOwn(row) && jobs.jobs.has(row.job))) {
				watch.watch(row);
				const key = joinedKey(row);
				if (!jobs.joined.has(key)) {
					const done = new Promise<void>((resolve) => {
						const map = ends.get(jobs) ?? new Map<string, () => void>();
						map.set(key, resolve);
						ends.set(jobs, map);
					});
					jobs.joined.set(key, {
						id: row.job,
						pid: row.pid,
						log: row.log,
						command: row.command,
						startedAt: row.started_at,
						done,
					});
				}
			}
			return row;
		},
		record: (job, agent) => ledger.record(job, agent),
		end: (job, exit) => ledger.end(job, exit),
		stop: () => {
			watch.stop();
			for (const finish of ends.get(jobs)?.values() ?? []) finish();
			ends.delete(jobs);
			jobs.joined.clear();
		},
	};
}
