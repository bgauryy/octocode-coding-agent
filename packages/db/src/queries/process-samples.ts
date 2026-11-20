import type { DatabaseSync } from "node:sqlite";

/**
 * Periodic memory samples of Octocode processes (main sessions, subagents, RPC hosts) and the child processes each
 * owned when it sampled. Every process writes its own rows; any process reads all of them, which is how a session finds
 * the children another session left behind. The table is created on first use (`IF NOT EXISTS`) instead of with the
 * schema, so the schema version is unchanged and an Octocode of another version sharing the file keeps working. `cwd` was added
 * later as a nullable column, added to a table that lacks it the same way.
 */

/** A process an Octocode process owns (an MCP server, a bash job, anything below them), named by pid plus start time. */
export interface OwnedChild {
	pid: number;
	/** Seconds since the epoch as a decimal string (`processStartTime`); null when it could not be read. */
	started: string | null;
	/** Its parent when it was sampled, to notice a later reparenting. */
	ppid: number;
	kind: string;
	label: string;
	/** Resident set size in bytes. */
	rss: number;
}

export interface ProcessSample {
	/** Milliseconds since the epoch. */
	at: number;
	pid: number;
	started: string | null;
	ppid: number;
	role: string;
	title: string;
	/** The part of the title after the role: the short session id or the agent id. */
	id: string;
	sessionId: string | null;
	agentId: string | null;
	/** The Octocode process that started this one (a subagent's parent), when there is one. */
	ownerPid: number | null;
	ownerStarted: string | null;
	/** The working folder of the process when it sampled; null in samples an older Octocode wrote. */
	cwd: string | null;
	/** Bytes. */
	rss: number;
	heapUsed: number;
	/** The last sample of a process that shut down on its own. */
	ended: boolean;
	children: OwnedChild[];
}

const created = new WeakSet<DatabaseSync>();

function ensure(db: DatabaseSync): void {
	if (created.has(db)) return;
	db.exec(`
CREATE TABLE IF NOT EXISTS process_samples (
  at INTEGER NOT NULL, pid INTEGER NOT NULL, started TEXT NOT NULL DEFAULT '', ppid INTEGER NOT NULL,
  role TEXT NOT NULL, title TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT, agent_id TEXT,
  owner_pid INTEGER, owner_started TEXT, rss INTEGER NOT NULL, heap_used INTEGER NOT NULL,
  ended INTEGER NOT NULL DEFAULT 0, children TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (pid, started, at));
CREATE INDEX IF NOT EXISTS process_samples_at ON process_samples(at);`);
	if (!db.prepare("SELECT 1 FROM pragma_table_info('process_samples') WHERE name = 'cwd'").get())
		db.exec("ALTER TABLE process_samples ADD COLUMN cwd TEXT");
	created.add(db);
}

/** Writes one sample; a second sample of the same process at the same instant replaces the first. */
export function record(db: DatabaseSync, sample: ProcessSample): void {
	ensure(db);
	db.prepare(
		`INSERT OR REPLACE INTO process_samples
		 (at, pid, started, ppid, role, title, id, session_id, agent_id, owner_pid, owner_started, rss, heap_used, ended, children, cwd)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		sample.at,
		sample.pid,
		sample.started ?? "",
		sample.ppid,
		sample.role,
		sample.title,
		sample.id,
		sample.sessionId,
		sample.agentId,
		sample.ownerPid,
		sample.ownerStarted,
		sample.rss,
		sample.heapUsed,
		sample.ended ? 1 : 0,
		JSON.stringify(sample.children),
		sample.cwd,
	);
}

interface SampleRow {
	at: number;
	pid: number;
	started: string;
	ppid: number;
	role: string;
	title: string;
	id: string;
	session_id: string | null;
	agent_id: string | null;
	owner_pid: number | null;
	owner_started: string | null;
	rss: number;
	heap_used: number;
	ended: number;
	children: string;
	cwd: string | null;
}

function parseChildren(text: string): OwnedChild[] {
	try {
		const parsed: unknown = JSON.parse(text);
		return Array.isArray(parsed) ? (parsed as OwnedChild[]) : [];
	} catch {
		return [];
	}
}

/** Every sample taken at or after `at` (ms since the epoch), oldest first, whatever process wrote it. */
export function since(db: DatabaseSync, at: number): ProcessSample[] {
	ensure(db);
	const rows = db
		.prepare("SELECT * FROM process_samples WHERE at >= ? ORDER BY at, pid")
		.all(at) as unknown as SampleRow[];
	return rows.map((row) => ({
		at: row.at,
		pid: row.pid,
		started: row.started === "" ? null : row.started,
		ppid: row.ppid,
		role: row.role,
		title: row.title,
		id: row.id,
		sessionId: row.session_id,
		agentId: row.agent_id,
		ownerPid: row.owner_pid,
		ownerStarted: row.owner_started,
		rss: row.rss,
		heapUsed: row.heap_used,
		ended: row.ended === 1,
		cwd: row.cwd,
		children: parseChildren(row.children),
	}));
}

/** Deletes the samples taken before `at` (ms since the epoch), the retention rule; returns how many went. */
export function pruneBefore(db: DatabaseSync, at: number): number {
	ensure(db);
	return Number(db.prepare("DELETE FROM process_samples WHERE at < ?").run(at).changes);
}

/** All-data purge: drops samples except those belonging to kept sessions, without creating the optional table. */
export function keepOnly(db: DatabaseSync, sessions: readonly string[]): number {
	if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='process_samples'").get()) return 0;
	return Number(
		db
			.prepare(
				"DELETE FROM process_samples WHERE session_id IS NULL OR session_id NOT IN (SELECT value FROM json_each(?))",
			)
			.run(JSON.stringify(sessions)).changes,
	);
}
