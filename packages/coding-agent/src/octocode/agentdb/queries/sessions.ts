import type { DatabaseSync } from "node:sqlite";
import { allRows } from "../rows.ts";

/**
 * What Octocode adds to one Octocode session (`sessions` row): the git branch and HEAD it last saw, its cost and tokens, the
 * files it changed, and the pid (with start time) of the process that has it open (the one record of whether a session is
 * running; see `agentdb/liveness`). The catalog columns (`CatalogRow`) cache the session file's listing facts; the
 * transcript stays the source of truth.
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

const EXTRA_COLUMNS = "id, branch, head, cost, tokens, files_changed, pid, pid_started, unpriced, dir";

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
