import type { DatabaseSync } from "node:sqlite";
import type { ActivityTone } from "@octocodeai/octocode-contracts";
import { allRows } from "../rows.ts";
import * as compactions from "./compactions.ts";
import { inTransaction } from "./transaction.ts";
import * as transcripts from "./transcripts.ts";

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
	/**
	 * The last light tone the process that has it open wrote (`setActivity`); null when none is known, and when the row's
	 * process is not the one that wrote it (`activity_by`). It describes that process only: a reader trusts it while
	 * `pid` is alive.
	 */
	activity: ActivityTone | null;
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

/**
 * Records the catalog columns of session `id`, creating its row when it has none. Like `bind`, a copy cannot replace
 * another project's history: a row that already has a file in another folder keeps its catalog when the entry names a
 * different folder and file (the same file or the same folder may always be refreshed).
 */
export function saveCatalog(db: DatabaseSync, id: string, entry: CatalogEntry): void {
	db.prepare(
		`INSERT INTO sessions (id, title, title_source, cwd, file, parent_file, created_at, last_active, message_count, first_prompt, file_mtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, title_source = excluded.title_source, cwd = excluded.cwd,
           file = excluded.file, parent_file = excluded.parent_file, created_at = excluded.created_at,
           last_active = excluded.last_active, message_count = excluded.message_count, first_prompt = excluded.first_prompt,
           file_mtime = excluded.file_mtime
         WHERE sessions.file IS NULL OR sessions.cwd = excluded.cwd OR sessions.file = excluded.file`,
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

/**
 * Records a new name for session `id` (null clears it) and the file's modification time after the rename wrote it.
 * Like `saveCatalog`, a copy cannot rename another project's history: the row changes only when it is in the caller's
 * `cwd` or holds the caller's `file`.
 */
export function saveTitle(
	db: DatabaseSync,
	id: string,
	title: string | null,
	titleSource: string | null,
	fileMtime: number | null,
	owner: { cwd: string; file: string },
): void {
	db.prepare(
		"UPDATE sessions SET title = ?, title_source = ?, file_mtime = ? WHERE id = ? AND file IS NOT NULL AND (cwd = ? OR file = ?)",
	).run(title, titleSource, fileMtime, id, owner.cwd, owner.file);
}

/** The rows with catalog data, those of sessions that ran in `cwd` when given. */
export function catalog(db: DatabaseSync, cwd?: string): CatalogRow[] {
	const columns =
		"id, title, title_source, cwd, file, parent_file, created_at, last_active, message_count, first_prompt, file_mtime";
	return cwd === undefined
		? allRows<CatalogRow>(db.prepare(`SELECT ${columns} FROM sessions WHERE file IS NOT NULL`))
		: allRows<CatalogRow>(db.prepare(`SELECT ${columns} FROM sessions WHERE file IS NOT NULL AND cwd = ?`), cwd);
}

/** The process a row names now, as `activity_by` records a writer: a light is read only when the two agree. */
const ROW_PROCESS = "pid || ':' || IFNULL(pid_started, '')";

const EXTRA_COLUMNS = `id, workspace_id, branch, head, cost, tokens, files_changed, pid, pid_started, unpriced, dir,
	CASE WHEN activity_by = ${ROW_PROCESS} THEN activity END AS activity`;

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

/**
 * This process has the session open now, from session dir `dir` when known. Keeps what earlier runs recorded, except the
 * light: a session that just started runs nothing (`idle`), whatever an earlier process last wrote.
 */
export function start(db: DatabaseSync, id: string, pid: number, pidStarted: string | null, dir: string | null): void {
	db.prepare(
		"INSERT INTO sessions (id, pid, pid_started, dir, activity, activity_by) VALUES (?, ?, ?, ?, 'idle', ?) ON CONFLICT(id) DO UPDATE SET pid = excluded.pid, pid_started = excluded.pid_started, dir = COALESCE(excluded.dir, sessions.dir), activity = 'idle', activity_by = excluded.activity_by",
	).run(id, pid, pidStarted, dir, `${pid}:${pidStarted ?? ""}`);
}

/** The light of session `id` as process `pid`, which has it open, shows it now; a row another process owns is left alone. */
export function setActivity(db: DatabaseSync, id: string, pid: number, activity: ActivityTone | null): void {
	db.prepare(`UPDATE sessions SET activity = ?, activity_by = ${ROW_PROCESS} WHERE id = ? AND pid = ?`).run(
		activity,
		id,
		pid,
	);
}

/**
 * Where session `id` runs (its working directory and session folder), creating a bare row when it has none and keeping
 * what is recorded. `file` is not written: it marks an indexed session (`catalog`), which a subagent's session is not.
 */
export function locate(db: DatabaseSync, id: string, cwd: string | null, dir: string | null): void {
	db.prepare(
		"INSERT INTO sessions (id, cwd, dir) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET cwd = COALESCE(sessions.cwd, excluded.cwd), dir = COALESCE(sessions.dir, excluded.dir)",
	).run(id, cwd, dir);
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

/** The process `pid` no longer has session `id` open: no process, so no light. */
export function clearPid(db: DatabaseSync, id: string, pid: number): void {
	db.prepare(
		"UPDATE sessions SET pid = NULL, pid_started = NULL, activity = NULL, activity_by = NULL WHERE id = ? AND pid = ?",
	).run(id, pid);
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
	timers: number;
}

const ERASE_STATEMENTS: ReadonlyArray<[Exclude<keyof EraseCounts, "transcripts" | "entries" | "compactions">, string]> =
	[
		[
			"forks",
			"DELETE FROM session_forks WHERE child_id IN (SELECT value FROM json_each(?1)) OR parent_id IN (SELECT value FROM json_each(?1))",
		],
		["events", "DELETE FROM agent_events WHERE session_id IN (SELECT value FROM json_each(?1))"],
		["tasks", "DELETE FROM backlog_tasks WHERE session_id IN (SELECT value FROM json_each(?1))"],
		["commands", "DELETE FROM workspace_commands WHERE session_id IN (SELECT value FROM json_each(?1))"],
		["timers", "DELETE FROM timers WHERE session_id IN (SELECT value FROM json_each(?1))"],
		["sessions", "DELETE FROM sessions WHERE id IN (SELECT value FROM json_each(?1))"],
	];

/**
 * Removes every per-session row of the given sessions, for a user's explicit deletion: in the transcript mirror (`mirror`)
 * its transcript, entries and compaction summaries (one transaction there, first), then in the coordination file (one
 * transaction) the `sessions` extras and catalog row, fork edges where the session is child or parent, its
 * `agent_events`, its session-scoped `backlog_tasks`, its `workspace_commands` receipts and its `timers`. Kept on purpose:
 * `backlog_audits` and `config_audits` (immutable history; deleting a task adds its own audit row), `agents` rows (a team
 * member has its own pid-based lifecycle), `backlog.source_session` and `memories.source_session` (provenance text). The
 * caller checks liveness first: a running session's row would come back at its next write. Housekeeping uses `forget`
 * instead: the mirror outlives the file (an ID-based fork recovers from it). Call it outside a coordination transaction:
 * the mirror's lock is always taken first.
 */
export function erase(db: DatabaseSync, mirror: DatabaseSync, ids: readonly string[]): EraseCounts {
	return { ...eraseMirror(mirror, ids), ...eraseRows(db, ids) };
}

/** The mirror's part of `erase`, in one transaction of the mirror: transcripts, their entries and compaction summaries. */
export function eraseMirror(
	mirror: DatabaseSync,
	ids: readonly string[],
): Pick<EraseCounts, "transcripts" | "entries" | "compactions"> {
	if (ids.length === 0) return { transcripts: 0, entries: 0, compactions: 0 };
	return inTransaction(mirror, () => ({
		...transcripts.erase(mirror, ids),
		compactions: compactions.erase(mirror, ids),
	}));
}

/** The coordination file's part of `erase`, in one transaction (it joins the caller's). */
export function eraseRows(
	db: DatabaseSync,
	ids: readonly string[],
): Omit<EraseCounts, "transcripts" | "entries" | "compactions"> {
	const counts = { sessions: 0, forks: 0, events: 0, tasks: 0, commands: 0, timers: 0 };
	if (ids.length === 0) return counts;
	const json = JSON.stringify([...new Set(ids)]);
	inTransaction(db, () => {
		for (const [key, sql] of ERASE_STATEMENTS) counts[key] += Number(db.prepare(sql).run(json).changes);
	});
	return counts;
}

/**
 * Housekeeping: discards the activity extras of session `id` (git state, spend, pid) and drops its row when nothing durable
 * hangs off it. A stored transcript or compaction summary in the mirror keeps the row (its catalog data too): durable
 * history survives missing or unmounted checkouts and a deleted file. `erase` removes everything.
 */
export function forget(db: DatabaseSync, mirror: DatabaseSync, id: string): void {
	if (!transcripts.has(mirror, id) && !compactions.has(mirror, id))
		db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
	db.prepare(`UPDATE sessions SET branch=NULL, head=NULL, cost=0, tokens=0, files_changed=0, pid=NULL,
		pid_started=NULL, unpriced=0, activity=NULL, activity_by=NULL WHERE id=?`).run(id);
}

/** Bind once. A copied file with an existing ID cannot replace another workspace's history. */
export function bind(db: DatabaseSync, id: string, workspaceId: string | null): void {
	const result = db
		.prepare(`INSERT INTO sessions(id,workspace_id) VALUES (?,?)
		ON CONFLICT(id) DO UPDATE SET workspace_id=COALESCE(sessions.workspace_id,excluded.workspace_id)
		WHERE sessions.workspace_id IS NULL OR excluded.workspace_id IS NULL OR sessions.workspace_id=excluded.workspace_id`)
		.run(id, workspaceId);
	if (!result.changes) throw new Error("Session ID is already bound to another workspace");
}
