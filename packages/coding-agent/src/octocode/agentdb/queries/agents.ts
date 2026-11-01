import type { DatabaseSync } from "node:sqlite";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { num, type Row } from "../rows.ts";

/** The process a member row names: the pid and, where known, its start time, so a reused pid is not taken for it. */
export interface ProcessIdentity {
	pid: number;
	started?: string | undefined;
}

/** The identity of an `agents` row. */
export interface MemberProcess extends ProcessIdentity {
	id: string;
}

const processRow = (row: Row): MemberProcess => ({
	id: String(row.id),
	pid: num(row.pid),
	...(typeof row.started === "string" ? { started: row.started } : {}),
});

/** The heartbeat's `UPDATE`: matches the row only while it still names this process (and records its `checkout` and session); whether it did. */
export function refresh(db: DatabaseSync, member: Member, checkout: string): boolean {
	const { changes } = db
		.prepare(
			`UPDATE agents SET status = ?, task = ?, activity = ?, model = ?, checkout = ?, session_id = ?, seen_at = ?, tool_calls = ?, input = ?, cache_read = ?, output = ?, cost = ?, unpriced = ?
         WHERE id = ? AND pid = ? AND started IS ?`,
		)
		.run(
			member.status,
			member.goal ?? null,
			member.activity ?? null,
			member.model ?? null,
			checkout,
			member.sessionId ?? null,
			member.updatedAt,
			member.toolCalls,
			member.input,
			member.cacheRead,
			member.output,
			member.cost,
			member.unpriced ? 1 : 0,
			member.id,
			member.pid,
			member.started ?? null,
		);
	return changes > 0;
}

/**
 * Adds the row of `team` (the git common dir) working in `checkout` (its worktree root) unless the id is taken
 * (`ON CONFLICT DO NOTHING`, so a name held by another process is never overwritten); whether it was added.
 */
export function insert(db: DatabaseSync, team: string, checkout: string, member: Member): boolean {
	const row = db
		.prepare(
			`INSERT INTO agents (id, workspace, checkout, tmux_pane, role, parent_id, pid, started, status, task, activity, model, joined_at, seen_at, tool_calls, input, cache_read, output, cost, unpriced, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING RETURNING id`,
		)
		.get(
			member.id,
			team,
			checkout,
			member.tmuxPane ?? null,
			member.role,
			member.parentId ?? null,
			member.pid,
			member.started ?? null,
			member.status,
			member.goal ?? null,
			member.activity ?? null,
			member.model ?? null,
			member.joinedAt,
			member.updatedAt,
			member.toolCalls,
			member.input,
			member.cacheRead,
			member.output,
			member.cost,
			member.unpriced ? 1 : 0,
			member.sessionId ?? null,
		);
	return row !== undefined;
}

/** Deletes the row of `id`. */
export function remove(db: DatabaseSync, id: string): void {
	db.prepare("DELETE FROM agents WHERE id = ?").run(id);
}

/** The process the row of `id` names; undefined when it has no row. */
export function processOf(db: DatabaseSync, id: string): ProcessIdentity | undefined {
	const row = db.prepare("SELECT pid, started FROM agents WHERE id = ?").get(id) as Row | undefined;
	return row ? { pid: num(row.pid), ...(typeof row.started === "string" ? { started: row.started } : {}) } : undefined;
}

/** The process of every agent of `team`. */
export function processes(db: DatabaseSync, team: string): MemberProcess[] {
	return (db.prepare("SELECT id, pid, started FROM agents WHERE workspace = ?").all(team) as Row[]).map(processRow);
}

/** The process of every agent in the database, whatever its workspace. */
export function allProcesses(db: DatabaseSync): MemberProcess[] {
	return (db.prepare("SELECT id, pid, started FROM agents").all() as Row[]).map(processRow);
}

/** Every agent name in the database (ids are unique across workspaces). */
export function ids(db: DatabaseSync): string[] {
	return (db.prepare("SELECT id FROM agents").all() as Row[]).map((row) => String(row.id));
}

/** The agent rows of `team`, oldest first, each with `pending`: the questions delivered to it and not yet answered (`deliveries.openQuestions`). */
export function inTeam(db: DatabaseSync, team: string): Row[] {
	return db
		.prepare(
			`SELECT a.*, (SELECT count(*) FROM deliveries d JOIN messages m ON m.id = d.message
                      WHERE d.recipient = a.id AND d.delivered_at IS NOT NULL AND d.completed_at IS NULL AND m.reply_required = 1
                        AND d.dead_at IS NULL AND d.relay_to IS NULL) AS pending
         FROM agents a WHERE a.workspace = ? ORDER BY a.joined_at, a.id`,
		)
		.all(team);
}

/** Agents of `team` that heartbeat at or after `floor` get `seen_at` raised to at least `now`. */
export function touchSeenSince(db: DatabaseSync, team: string, floor: number, now: number): void {
	db.prepare("UPDATE agents SET seen_at = MAX(seen_at, ?) WHERE workspace = ? AND seen_at >= ?").run(now, team, floor);
}

/** How long this connection waits for a lock held by another process before it fails with "database is locked". */
export function setBusyTimeout(db: DatabaseSync, ms: number): void {
	db.exec(`PRAGMA busy_timeout=${ms}`);
}
