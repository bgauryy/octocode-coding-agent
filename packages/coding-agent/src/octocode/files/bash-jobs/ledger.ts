import os from "node:os";
import path from "node:path";
import { sha256 } from "@octocodeai/octocode-common/atomic-file";
import { type AgentDb, type JobRow, jobs } from "../../../../../db/src/api.ts";
import { registeredWorkspace } from "../../../storage/workspace-database.ts";
import { ownerAlive } from "../../shared/job-standing.ts";
import type { BashJob, JobExit } from "./types.ts";

/**
 * The command with runs of spaces and tabs outside quotes made one space and its ends trimmed: two spellings that differ
 * only so run the same command. Nothing else is changed, so a different command never joins.
 */
function normalizeCommand(command: string): string {
	let out = "";
	let quote: string | undefined;
	let pendingSpace = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (!quote && (char === " " || char === "\t")) {
			pendingSpace = true;
			continue;
		}
		if (pendingSpace && out !== "" && !out.endsWith("\n")) out += " ";
		pendingSpace = false;
		out += char;
		if (char === "\\" && quote !== "'" && i + 1 < command.length) out += command[++i];
		else if (quote === char) quote = undefined;
		else if (!quote && (char === "'" || char === '"')) quote = char;
	}
	return out;
}

/** What two background starts must share to be one run: the workspace, the folder and the normalized command. */
const joinKey = (workspaceId: string, cwd: string, command: string): string =>
	sha256(JSON.stringify([workspaceId, path.resolve(cwd), normalizeCommand(command)]));

/**
 * The background jobs of every session of this host as rows (`jobs` table), written when a job starts and ended. A row
 * finds and describes a job; it grants nothing over it: only the job's own owner record signals its process.
 */
export class JobLedger {
	private readonly agentDb: () => AgentDb;
	private readonly sessionId: () => string;

	constructor(agentDb: () => AgentDb, sessionId: () => string) {
		this.agentDb = agentDb;
		this.sessionId = sessionId;
	}

	/** Records a job that just started. */
	record(job: BashJob, agent: string | undefined): void {
		const db = this.agentDb();
		const workspace = registeredWorkspace(job.cwd, db);
		jobs.insert(db.db, {
			workspaceId: workspace.id,
			sessionId: this.sessionId(),
			job: job.id,
			...(agent ? { agent } : {}),
			...(job.item ? { item: job.item } : {}),
			command: job.command,
			cwd: job.cwd,
			key: joinKey(workspace.id, job.cwd, job.command),
			pid: job.pid,
			host: os.hostname(),
			log: job.log,
			at: job.startedAt,
		});
	}

	/** Marks the job ended: stopped when the feature stopped it, else finished. */
	end(job: BashJob, exit: JobExit, at = Date.now()): void {
		jobs.end(this.agentDb().db, this.sessionId(), job.id, job.stopped ? "stopped" : "finished", exit.code, at);
	}

	/** The oldest running job with this workspace, folder and command whose owner is alive, if any. */
	joinable(cwd: string, command: string): JobRow | undefined {
		const db = this.agentDb();
		const workspace = registeredWorkspace(cwd, db);
		return jobs.runningByKey(db.db, workspace.id, joinKey(workspace.id, cwd, command)).find((row) => ownerAlive(row));
	}

	/** A job's row now, to see whether it ended. */
	current(row: Pick<JobRow, "session_id" | "job">): JobRow | undefined {
		return jobs.bySessionJob(this.agentDb().db, row.session_id, row.job);
	}

	/** Whether the row is a job of this session. */
	isOwn(row: Pick<JobRow, "session_id">): boolean {
		return row.session_id === this.sessionId();
	}
}
