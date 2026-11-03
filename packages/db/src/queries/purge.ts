import type { DatabaseSync } from "node:sqlite";
import { erase } from "./sessions.ts";
import { inTransaction } from "./transaction.ts";

/**
 * Rows removed per table by `workspace` and `all`. Keys are table names (`sessions` counts the extras and catalog rows;
 * transcripts, entries, forks, compactions, events and tasks of a session are counted as `erase` reports them).
 */
export type PurgeCounts = Record<string, number>;

/** Audit tables refuse DELETE with a trigger; a purge lifts that guard inside its own transaction only (see `history.deleteRows`). */
const AUDIT_GUARDS = ["backlog_audits_immutable_delete", "config_audits_immutable_delete"] as const;

/** Meta keys holding per-workspace counters (`backlog_seq:<id>`, `backlog_task_seq:<id>`); other meta rows are settings. */
const MARKS = ["backlog_seq:", "backlog_task_seq:"] as const;

type Statement = readonly [table: string, sql: string];

/** Runs `statements` in order, each bound to the first `?N` arguments it names, adding each change count to `counts`. */
function run(db: DatabaseSync, statements: readonly Statement[], counts: PurgeCounts, ...args: string[]): void {
	for (const [table, sql] of statements) {
		const used = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1])));
		counts[table] = (counts[table] ?? 0) + Number(db.prepare(sql).run(...args.slice(0, used)).changes);
	}
}

/** Runs `work` with the audit DELETE guards dropped and restored exactly as stored, inside the caller's transaction. */
function withoutAuditGuards<T>(db: DatabaseSync, work: () => T): T {
	const stored = AUDIT_GUARDS.flatMap((name) => {
		const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
		return row ? [{ name, sql: String(row.sql) }] : [];
	});
	for (const { name } of stored) db.exec(`DROP TRIGGER ${name}`);
	try {
		return work();
	} finally {
		for (const { sql } of stored) db.exec(sql);
	}
}

const marks = (column: string) => MARKS.map((prefix) => `${column} LIKE '${prefix}%'`).join(" OR ");

/** What a purge leaves alone. */
export interface PurgeOptions {
	/**
	 * Sessions that keep every per-session row (sessions, transcripts, entries, compaction summaries, events, tasks,
	 * command receipts, the team member that runs it) and the workspace row they reference, so a session that is still
	 * running (the current one) can continue. A fork edge survives only when both of its ends are kept: a kept fork whose
	 * parent is purged loses its edge, since the edge references the parent's row.
	 */
	keepSessions?: readonly string[];
}

const KEPT = "(SELECT value FROM json_each(?2))";
/** The session ids a statement spares: `?2` is the JSON list of kept ids. */
const notKept = (column: string) => `COALESCE(${column}, '') NOT IN ${KEPT}`;

/** Children first: cascades cover backlog links, notes, comments; completions and audits do not cascade. `?1` workspace, `?2` kept ids. */
const WORKSPACE: readonly Statement[] = [
	["backlog_tasks", `DELETE FROM backlog_tasks WHERE workspace_id = ?1 AND ${notKept("session_id")}`],
	[
		"backlog_completions",
		"DELETE FROM backlog_completions WHERE item IN (SELECT id FROM backlog WHERE workspace_id = ?1)",
	],
	["backlog", "DELETE FROM backlog WHERE workspace_id = ?1"],
	["backlog_audits", "DELETE FROM backlog_audits WHERE workspace_id = ?1"],
	["workspace_commands", `DELETE FROM workspace_commands WHERE workspace_id = ?1 AND ${notKept("session_id")}`],
	["memories", "DELETE FROM memories WHERE workspace_id = ?1"],
	["agent_events", `DELETE FROM agent_events WHERE workspace_id = ?1 AND ${notKept("session_id")}`],
	["compaction_summaries", `DELETE FROM compaction_summaries WHERE workspace_id = ?1 AND ${notKept("session_id")}`],
	["messages", "DELETE FROM messages WHERE workspace_id = ?1"],
	["leases", "DELETE FROM leases WHERE workspace_id = ?1"],
	["edits", "DELETE FROM edits WHERE workspace_id = ?1"],
	["agents", "UPDATE agents SET lease_workspace_id = NULL WHERE lease_workspace_id = ?1 AND workspace_id <> ?1"],
	[
		"agents",
		`DELETE FROM agents WHERE workspace_id = ?1 AND ${notKept("session_id")} AND ${notKept("lifecycle_session_id")}`,
	],
	["meta", `DELETE FROM meta WHERE ${MARKS.map((prefix) => `key = '${prefix}' || ?1`).join(" OR ")}`],
	// Only kept sessions are left on this workspace by now, and they reference its row.
	[
		"workspaces",
		"DELETE FROM workspaces WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM sessions WHERE workspace_id = ?1)",
	],
];

/**
 * Removes everything the workspace owns, in one transaction: its sessions with their transcripts, entries, forks,
 * compaction summaries, events and tasks (`erase`), backlog items with links, notes, comments, completions, tasks
 * and audits, command receipts, workspace-scoped memories, agent events, compaction summaries, team messages (with their
 * deliveries), leases, edits, its team members and its backlog counters, then the `workspaces` row. A member of another
 * workspace that leased files here only loses the lease link (`agents.lease_workspace_id`).
 *
 * Kept: `config_audits` (not workspace-scoped), project- and global-scope memories, `trusted_folders` (a trust decision
 * names a folder, not a workspace), all other `meta` rows, other workspaces, and what `options.keepSessions` names (with
 * the `workspaces` row of a kept session of this workspace). Sessions without a workspace are not this workspace's.
 * Returns the rows removed per table (counts with zero rows are included).
 */
export function workspace(db: DatabaseSync, workspaceId: string, options: PurgeOptions = {}): PurgeCounts {
	const counts: PurgeCounts = {};
	const kept = JSON.stringify([...(options.keepSessions ?? [])]);
	inTransaction(db, () => {
		const keep = new Set(options.keepSessions);
		const ids = db
			.prepare("SELECT id FROM sessions WHERE workspace_id = ?")
			.all(workspaceId)
			.map((row) => String(row.id))
			.filter((id) => !keep.has(id));
		for (const [table, n] of Object.entries(erase(db, ids))) counts[table] = n;
		withoutAuditGuards(db, () => run(db, WORKSPACE, counts, workspaceId, kept));
	});
	return counts;
}

/** `?1` is the JSON list of kept session ids. */
const K = "(SELECT value FROM json_each(?1))";
const outside = (column: string) => `COALESCE(${column}, '') NOT IN ${K}`;
const ALL: readonly Statement[] = [
	["backlog_tasks", `DELETE FROM backlog_tasks WHERE ${outside("session_id")}`],
	["backlog_completions", "DELETE FROM backlog_completions"],
	["backlog", "DELETE FROM backlog"],
	["backlog_audits", "DELETE FROM backlog_audits"],
	["config_audits", "DELETE FROM config_audits"],
	["workspace_commands", `DELETE FROM workspace_commands WHERE ${outside("session_id")}`],
	["deliveries", "DELETE FROM deliveries"],
	["messages", "DELETE FROM messages"],
	["leases", "DELETE FROM leases"],
	["edits", "DELETE FROM edits"],
	["agent_events", `DELETE FROM agent_events WHERE ${outside("session_id")}`],
	["agents", `DELETE FROM agents WHERE ${outside("session_id")} AND ${outside("lifecycle_session_id")}`],
	["compaction_summaries", `DELETE FROM compaction_summaries WHERE ${outside("session_id")}`],
	["session_entries", `DELETE FROM session_entries WHERE ${outside("session_id")}`],
	["session_transcripts", `DELETE FROM session_transcripts WHERE ${outside("session_id")}`],
	["session_forks", `DELETE FROM session_forks WHERE NOT (child_id IN ${K} AND parent_id IN ${K})`],
	["sessions", `DELETE FROM sessions WHERE ${outside("id")}`],
	["memories", "DELETE FROM memories"],
	["meta", `DELETE FROM meta WHERE ${marks("key")}`],
	// A kept agent may lease a workspace that goes next: drop that link first, or the workspace delete fails its FK.
	[
		"agents",
		"UPDATE agents SET lease_workspace_id = NULL WHERE lease_workspace_id NOT IN (SELECT workspace_id FROM sessions WHERE workspace_id IS NOT NULL)",
	],
	[
		"workspaces",
		"DELETE FROM workspaces WHERE id NOT IN (SELECT workspace_id FROM sessions WHERE workspace_id IS NOT NULL)",
	],
];

/**
 * Empties every data table in one transaction and keeps the schema (tables, indexes, triggers, FTS index, application
 * id and `user_version`), so the file opens as before. Kept: `trusted_folders` (security decisions, like settings and
 * authentication outside the database), `meta` rows other than the workspace backlog counters (memory auto-save
 * setting, registered session folders, sweep claims), and what `options.keepSessions` names with the `workspaces` rows
 * they reference. Run `maintenance.vacuum` after it to give the space back.
 */
export function all(db: DatabaseSync, options: PurgeOptions = {}): PurgeCounts {
	const counts: PurgeCounts = {};
	const kept = JSON.stringify([...(options.keepSessions ?? [])]);
	inTransaction(db, () => withoutAuditGuards(db, () => run(db, ALL, counts, kept)));
	return counts;
}
