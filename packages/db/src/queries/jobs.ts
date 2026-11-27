import type { DatabaseSync } from "node:sqlite";
import { allRows } from "../rows.ts";
import { keptStatement } from "../statements.ts";

export type JobState = "running" | "finished" | "stopped";

/**
 * A background `bash` job of some session. A row shows and matches a job; it grants no right over it: only the job's private
 * owner record (found by `pid` and `log`) signals the process.
 */
export interface JobRow {
	id: number;
	workspace_id: string;
	session_id: string;
	/** The session's own id for the job (`bash-4`). */
	job: string;
	agent: string | null;
	item: string | null;
	command: string;
	cwd: string;
	/** Hash of the workspace, folder and normalized command: an identical start joins a running job with this key. */
	key: string;
	pid: number;
	host: string | null;
	log: string;
	state: JobState;
	exit_code: number | null;
	started_at: number;
	ended_at: number | null;
	updated_at: number;
}

/** The stored fields of a new running job. */
export interface NewJob {
	workspaceId: string;
	sessionId: string;
	job: string;
	agent?: string;
	item?: string;
	command: string;
	cwd: string;
	key: string;
	pid: number;
	host?: string;
	log: string;
	at: number;
}

/**
 * Records a job that started. A session's job ids restart after a /reload, so a row of the same session and id is the
 * earlier instance's job: the new job replaces it.
 */
export function insert(db: DatabaseSync, job: NewJob): void {
	db.prepare(
		`INSERT INTO jobs (workspace_id, session_id, job, agent, item, command, cwd, key, pid, host, log, started_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(session_id, job) DO UPDATE SET workspace_id = excluded.workspace_id, agent = excluded.agent,
		   item = excluded.item, command = excluded.command, cwd = excluded.cwd, key = excluded.key, pid = excluded.pid,
		   host = excluded.host, log = excluded.log, state = 'running', exit_code = NULL, started_at = excluded.started_at,
		   ended_at = NULL, updated_at = excluded.updated_at`,
	).run(
		job.workspaceId,
		job.sessionId,
		job.job,
		job.agent ?? null,
		job.item ?? null,
		job.command,
		job.cwd,
		job.key,
		job.pid,
		job.host ?? null,
		job.log,
		job.at,
		job.at,
	);
}

/** Marks a session's running job ended (`finished` or `stopped`) with its exit code; false when it is not running. */
export function end(
	db: DatabaseSync,
	sessionId: string,
	job: string,
	state: Exclude<JobState, "running">,
	exitCode: number | null,
	at: number,
): boolean {
	return (
		Number(
			db
				.prepare(
					"UPDATE jobs SET state = ?, exit_code = ?, ended_at = ?, updated_at = ? WHERE session_id = ? AND job = ? AND state = 'running'",
				)
				.run(state, exitCode, at, at, sessionId, job).changes,
		) > 0
	);
}

/** Running jobs of the workspace whose key is `key`, oldest first: candidates to join (the caller checks each one's owner is alive). */
export function runningByKey(db: DatabaseSync, workspaceId: string, key: string): JobRow[] {
	return allRows<JobRow>(
		keptStatement(db, "SELECT * FROM jobs WHERE workspace_id = ? AND key = ? AND state = 'running' ORDER BY id"),
		workspaceId,
		key,
	);
}

/** Every job of the workspace still marked running, oldest first. */
export function running(db: DatabaseSync, workspaceId: string): JobRow[] {
	return allRows<JobRow>(
		keptStatement(db, "SELECT * FROM jobs WHERE workspace_id = ? AND state = 'running' ORDER BY id"),
		workspaceId,
	);
}

/** The running jobs that name one of the items `refs` (`B12`), oldest first. */
export function runningForItems(db: DatabaseSync, workspaceId: string, refs: readonly string[]): JobRow[] {
	if (refs.length === 0) return [];
	return allRows<JobRow>(
		db.prepare(
			"SELECT * FROM jobs WHERE workspace_id = ? AND state = 'running' AND item IN (SELECT value FROM json_each(?)) ORDER BY id",
		),
		workspaceId,
		JSON.stringify(refs),
	);
}

/** One session's job by its own id. */
export function bySessionJob(db: DatabaseSync, sessionId: string, job: string): JobRow | undefined {
	return keptStatement(db, "SELECT * FROM jobs WHERE session_id = ? AND job = ?").get(sessionId, job) as
		| JobRow
		| undefined;
}

/** The process `pid` exists (signal 0 only probes). A permission error means it exists under another user. */
function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Retention: drops ended jobs that ended before `cutoff`, and jobs still marked running but untouched since then whose
 * process is gone (their session died without recording the end). A running job is not touched while it runs, so one
 * whose process still exists stays however long it has run; a job on another host cannot be probed and is dropped by age.
 */
export function purgeBefore(db: DatabaseSync, cutoff: number): number {
	let removed = Number(db.prepare("DELETE FROM jobs WHERE state <> 'running' AND ended_at < ?").run(cutoff).changes);
	const stale = db.prepare("SELECT id, pid, host FROM jobs WHERE state = 'running' AND updated_at < ?").all(cutoff) as {
		id: number;
		pid: number;
		host: string | null;
	}[];
	const remove = db.prepare("DELETE FROM jobs WHERE id = ?");
	for (const job of stale) if (job.host !== null || !pidExists(job.pid)) removed += Number(remove.run(job.id).changes);
	return removed;
}
