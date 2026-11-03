import type { DatabaseSync } from "node:sqlite";
import { allRows } from "../rows.ts";
import { inTransaction } from "./transaction.ts";

/**
 * What Octocode adds to one Octocode session (`sessions` row): the git branch and HEAD it last saw, its cost and tokens, the
 * files it changed, and the pid (with start time) of the process that has it open (the one record of whether a session is
 * running; see `shared/session-liveness`). The catalog columns (`CatalogRow`) cache the session file's listing facts; the
 * transcript stays the source of truth.
 */
export interface SessionExtra {
	id: string;
	workspace_id: string | null;
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

/** What the catalog columns of a `sessions` row hold: a session file's listing facts, so a listing need not parse it. */
export interface CatalogEntry {
	/** The session's name; null when it has none. */
	title: string | null;
	/** Who named it: `user`, `auto` or `goal`; null with no name. */
	titleSource: string | null;
	cwd: string;
	/** The session file. */
	file: string;
	/** The file this session was forked from. */
	parentFile: string | null;
	createdAt: number;
	/** The listing's modified time (the last user or assistant message, else the header time). */
	lastActive: number;
	messageCount: number;
	/** The first user message, cleaned and cut to 200 characters; null with none. */
	firstPrompt: string | null;
	/** The file's own modification time when this entry was written; null when it did not exist yet. */
	fileMtime: number | null;
}

/** A `sessions` row that has catalog data. */
export interface CatalogRow {
	id: string;
	title: string | null;
	title_source: string | null;
	cwd: string;
	file: string;
	parent_file: string | null;
	created_at: number;
	last_active: number;
	message_count: number;
	first_prompt: string | null;
	file_mtime: number | null;
}

/** Records the catalog columns of session `id`, creating its row when it has none. */
export function saveCatalog(db: DatabaseSync, id: string, entry: CatalogEntry): void {
	db.prepare(
		`INSERT INTO sessions (id, title, title_source, cwd, file, parent_file, created_at, last_active, message_count, first_prompt, file_mtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, title_source = excluded.title_source, cwd = excluded.cwd,
           file = excluded.file, parent_file = excluded.parent_file, created_at = excluded.created_at,
           last_active = excluded.last_active, message_count = excluded.message_count, first_prompt = excluded.first_prompt,
           file_mtime = excluded.file_mtime`,
	).run(
		id,
		entry.title,
		entry.titleSource,
		entry.cwd,
		entry.file,
		entry.parentFile,
		entry.createdAt,
		entry.lastActive,
		entry.messageCount,
		entry.firstPrompt,
		entry.fileMtime,
	);
}

/** Records a new name for session `id` (null clears it) and the file's modification time after the rename wrote it. */
export function saveTitle(
	db: DatabaseSync,
	id: string,
	title: string | null,
	titleSource: string | null,
	fileMtime: number | null,
): void {
	db.prepare("UPDATE sessions SET title = ?, title_source = ?, file_mtime = ? WHERE id = ? AND file IS NOT NULL").run(
		title,
		titleSource,
		fileMtime,
		id,
	);
}

/** The rows with catalog data, those of sessions that ran in `cwd` when given. */
export function catalog(db: DatabaseSync, cwd?: string): CatalogRow[] {
	const columns =
		"id, title, title_source, cwd, file, parent_file, created_at, last_active, message_count, first_prompt, file_mtime";
	return cwd === undefined
		? allRows<CatalogRow>(db.prepare(`SELECT ${columns} FROM sessions WHERE file IS NOT NULL`))
		: allRows<CatalogRow>(db.prepare(`SELECT ${columns} FROM sessions WHERE file IS NOT NULL AND cwd = ?`), cwd);
}

const EXTRA_COLUMNS = "id, workspace_id, branch, head, cost, tokens, files_changed, pid, pid_started, unpriced, dir";

/** The session extras of `id`, or undefined when it has no row. */
export function byId(db: DatabaseSync, id: string): SessionExtra | undefined {
	return db.prepare(`SELECT ${EXTRA_COLUMNS} FROM sessions WHERE id = ?`).get(id) as SessionExtra | undefined;
}

export function all(db: DatabaseSync): SessionExtra[] {
	return allRows<SessionExtra>(db.prepare(`SELECT ${EXTRA_COLUMNS} FROM sessions`));
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

/**
 * Records usage and git state of session `id`; an unknown branch or head keeps what was recorded. The writer is the
 * process that has the session open, so the pid is asserted here too: a row created without one (the bind and start of
 * `session_start` failed, or another writer made the row first) is repaired at the next agent_end. The same pid keeps
 * its recorded start time when `ps` could not read one now; a different pid replaces both, as `start` does.
 */
export function saveStats(db: DatabaseSync, id: string, stats: StatsRow): void {
	db.prepare(
		`INSERT INTO sessions (id, cost, tokens, files_changed, unpriced, branch, head, pid, pid_started) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET cost = excluded.cost, tokens = excluded.tokens, files_changed = excluded.files_changed,
           unpriced = excluded.unpriced, branch = COALESCE(excluded.branch, sessions.branch), head = COALESCE(excluded.head, sessions.head),
           pid_started = CASE WHEN sessions.pid = excluded.pid THEN COALESCE(excluded.pid_started, sessions.pid_started) ELSE excluded.pid_started END,
           pid = excluded.pid`,
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

/** Rows removed by `erase`, per table. */
export interface EraseCounts {
	sessions: number;
	transcripts: number;
	entries: number;
	forks: number;
	compactions: number;
	events: number;
	tasks: number;
	commands: number;
}

const ERASE_STATEMENTS: ReadonlyArray<[keyof EraseCounts, string]> = [
	// Children before the sessions row: session_entries cascade from transcripts, the rest from sessions (composite FK).
	["entries", "DELETE FROM session_entries WHERE session_id IN (SELECT value FROM json_each(?1))"],
	["transcripts", "DELETE FROM session_transcripts WHERE session_id IN (SELECT value FROM json_each(?1))"],
	[
		"forks",
		"DELETE FROM session_forks WHERE child_id IN (SELECT value FROM json_each(?1)) OR parent_id IN (SELECT value FROM json_each(?1))",
	],
	["compactions", "DELETE FROM compaction_summaries WHERE session_id IN (SELECT value FROM json_each(?1))"],
	["events", "DELETE FROM agent_events WHERE session_id IN (SELECT value FROM json_each(?1))"],
	["tasks", "DELETE FROM backlog_tasks WHERE session_id IN (SELECT value FROM json_each(?1))"],
	["commands", "DELETE FROM workspace_commands WHERE session_id IN (SELECT value FROM json_each(?1))"],
	["sessions", "DELETE FROM sessions WHERE id IN (SELECT value FROM json_each(?1))"],
];

/**
 * Removes every per-session row of the given sessions in one transaction, for a user's explicit deletion: the `sessions`
 * extras and catalog row, the transcript mirror (`session_transcripts`, `session_entries`), fork edges where the session is
 * child or parent, compaction summaries, its `agent_events`, its session-scoped `backlog_tasks` and its
 * `workspace_commands` receipts. Kept on purpose: `backlog_audits` and `config_audits` (immutable history; deleting a task
 * adds its own audit row), `agents` rows (a team member has its own pid-based lifecycle), `backlog.source_session` and
 * `memories.source_session` (provenance text). The caller checks liveness first: a running session's row would come back
 * at its next write. Housekeeping uses `forget` instead: the mirror outlives the file (an ID-based fork recovers from it).
 */
export function erase(db: DatabaseSync, ids: readonly string[]): EraseCounts {
	const counts: EraseCounts = {
		sessions: 0,
		transcripts: 0,
		entries: 0,
		forks: 0,
		compactions: 0,
		events: 0,
		tasks: 0,
		commands: 0,
	};
	if (ids.length === 0) return counts;
	const json = JSON.stringify([...new Set(ids)]);
	inTransaction(db, () => {
		for (const [key, sql] of ERASE_STATEMENTS) counts[key] += Number(db.prepare(sql).run(json).changes);
	});
	return counts;
}

/**
 * Housekeeping: discards the activity extras of session `id` (git state, spend, pid) and drops its row when nothing durable
 * hangs off it. A transcript mirror or compaction summary keeps the row (its catalog data too): durable history survives
 * missing or unmounted checkouts and a deleted file. `erase` removes everything.
 */
export function forget(db: DatabaseSync, id: string): void {
	db.prepare(`DELETE FROM sessions WHERE id = ? AND NOT EXISTS
		(SELECT 1 FROM session_transcripts WHERE session_id=sessions.id) AND NOT EXISTS
		(SELECT 1 FROM compaction_summaries WHERE session_id=sessions.id)`).run(id);
	db.prepare(`UPDATE sessions SET branch=NULL, head=NULL, cost=0, tokens=0, files_changed=0, pid=NULL,
		pid_started=NULL, unpriced=0 WHERE id=?`).run(id);
}
