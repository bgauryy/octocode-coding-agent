import type { DatabaseSync } from "node:sqlite";

/**
 * What Octocode adds to one Octocode session (`sessions` row): the git branch and HEAD it last saw, its cost and tokens, the
 * files it changed, and the pid (with start time) of the process that has it open (the one record of whether a session is
 * running; see `agentdb/liveness`). Everything else (file, cwd, name, first message,
 * times) comes from Octocode's session listing.
 */
export interface SessionExtra {
	id: string;
	branch: string | null;
	head: string | null;
	cost: number;
	tokens: number;
	files_changed: number;
	pid: number | null;
	/** When that process started (`processStartTime`); null in rows from before it was recorded, or where it is unknown. */
	pid_started: string | null;
	/** 1 when part of the session's usage came from a model without pricing (its cost is incomplete). */
	unpriced: number;
	/** The session dir it last ran from (resolved); null in rows from before it was recorded. */
	dir: string | null;
}

/** The session extras of `id`, or undefined when it has no row. */
export function byId(db: DatabaseSync, id: string): SessionExtra | undefined {
	return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionExtra | undefined;
}

export function all(db: DatabaseSync): SessionExtra[] {
	return db.prepare("SELECT * FROM sessions").all() as unknown as SessionExtra[];
}

/** The pid and process start time recorded for session `id`, or undefined when it has no row. */
export function pidOf(db: DatabaseSync, id: string): { pid: number | null; pid_started: string | null } | undefined {
	return db.prepare("SELECT pid, pid_started FROM sessions WHERE id = ?").get(id) as
		| { pid: number | null; pid_started: string | null }
		| undefined;
}

/** This process has the session open now, from session dir `dir` when known. Keeps what earlier runs recorded. */
export function start(db: DatabaseSync, id: string, pid: number, pidStarted: string | null, dir: string | null): void {
	db.prepare(
		"INSERT INTO sessions (id, pid, pid_started, dir) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, pid_started = excluded.pid_started, dir = COALESCE(excluded.dir, sessions.dir)",
	).run(id, pid, pidStarted, dir);
}

export interface StatsRow {
	cost: number;
	tokens: number;
	filesChanged: number;
	unpriced: boolean;
	branch: string | null;
	head: string | null;
	pid: number;
	pidStarted: string | null;
}

/** Records usage and git state of session `id`; an unknown branch or head keeps what was recorded. */
export function saveStats(db: DatabaseSync, id: string, stats: StatsRow): void {
	db.prepare(
		`INSERT INTO sessions (id, cost, tokens, files_changed, unpriced, branch, head, pid, pid_started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET cost = excluded.cost, tokens = excluded.tokens, files_changed = excluded.files_changed,
           unpriced = excluded.unpriced, branch = COALESCE(excluded.branch, sessions.branch), head = COALESCE(excluded.head, sessions.head)`,
	).run(
		id,
		stats.cost,
		stats.tokens,
		stats.filesChanged,
		stats.unpriced ? 1 : 0,
		stats.branch,
		stats.head,
		stats.pid,
		stats.pidStarted,
	);
}

/** Records where git stood, without touching the stats. */
export function saveGit(db: DatabaseSync, id: string, branch: string | null, head: string | null): void {
	db.prepare("UPDATE sessions SET branch = COALESCE(?, branch), head = COALESCE(?, head) WHERE id = ?").run(
		branch,
		head,
		id,
	);
}

/** The process `pid` no longer has session `id` open. */
export function clearPid(db: DatabaseSync, id: string, pid: number): void {
	db.prepare("UPDATE sessions SET pid = NULL, pid_started = NULL WHERE id = ? AND pid = ?").run(id, pid);
}

export function forget(db: DatabaseSync, id: string): void {
	db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}
