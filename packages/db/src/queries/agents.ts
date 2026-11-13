import * as events from "./agent-events.ts";
import type { DatabaseSync } from "node:sqlite";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { num, type Row } from "../rows.ts";
import * as runs from "./agent-runs.ts";

/** The process a member row names: the pid and, where known, its start time, so a reused pid is not taken for it. */
export interface ProcessIdentity {
	pid: number;
	started?: string | undefined;
}

/** The identity of an `agents` row, with its last heartbeat (`seen_at`). */
export interface MemberProcess extends ProcessIdentity {
	id: string;
	seenAt: number;
}

/** The agent's origin and, only for delegated file reservations, the checkout those reservations protect. */
export interface MemberWorkspace {
	id: string;
	leaseWorkspaceId?: string;
	/** Where the process works now; it is written at the join and with each heartbeat, and never makes an event. */
	place?: MemberPlace;
}

/** The directory, git branch and process name of an agent's process. */
export interface MemberPlace {
	cwd?: string | undefined;
	branch?: string | undefined;
	processTitle?: string | undefined;
}

const CHECKOUT = "JOIN workspaces w ON w.id = COALESCE(a.lease_workspace_id, a.workspace_id)";

const processRow = (row: Row): MemberProcess => ({
	id: String(row.id),
	pid: num(row.pid),
	...(typeof row.started === "string" ? { started: row.started } : {}),
	seenAt: num(row.seen_at),
});

/** The heartbeat's `UPDATE`: matches the row only while it still names this process (and records its `checkout` and session); whether it did. */
export function refresh(
	db: DatabaseSync,
	member: Member,
	workspace: MemberWorkspace,
	context?: events.LifecycleContext,
): boolean {
	const before = events.member(db, member.id);
	const { changes } = db
		.prepare(
			`UPDATE agents SET status = ?, task = ?, activity = ?, model = ?, lease_workspace_id = ?, workspace_id = ?, session_id = ?, cwd = COALESCE(?, cwd), branch = COALESCE(?, branch), process_title = COALESCE(?, process_title), seen_at = ?, tool_calls = ?, input = ?, cache_read = ?, cache_write = ?, output = ?, cost = ?, unpriced = ?
         WHERE id = ? AND pid = ? AND started IS ?`,
		)
		.run(
			member.status,
			member.goal ?? null,
			member.activity ?? null,
			member.model ?? null,
			workspace.leaseWorkspaceId ?? null,
			workspace.id,
			member.sessionId ?? null,
			workspace.place?.cwd ?? null,
			workspace.place?.branch ?? null,
			workspace.place?.processTitle ?? null,
			member.updatedAt,
			member.toolCalls,
			member.input,
			member.cacheRead,
			member.cacheWrite ?? 0,
			member.output,
			member.cost,
			member.unpriced ? 1 : 0,
			member.id,
			member.pid,
			member.started ?? null,
		);
	if (changes > 0) {
		events.registerMember(db, member.id, context, member.updatedAt);
		const after = events.member(db, member.id)!;
		const fields = ["task", "model", "session_id", "role", "parent_id", "lifecycle_session_id"];
		const changed = fields.filter((key) => before?.[key] !== after[key]);
		if (before?.registration_id && changed.length)
			events.recordMember(
				db,
				after,
				"update",
				{
					changes: Object.fromEntries(changed.map((key) => [key, { before: before[key], after: after[key] }])),
				},
				member.updatedAt,
			);
	}
	return changes > 0;
}

/**
 * Adds the row for this team and origin workspace unless the team address is taken
 * (`ON CONFLICT DO NOTHING`, so a name held by another process is never overwritten); whether it was added.
 */
export function insert(
	db: DatabaseSync,
	team: string,
	workspace: MemberWorkspace,
	member: Member,
	context?: events.LifecycleContext,
): boolean {
	const row = db
		.prepare(
			`INSERT INTO agents (id, team, lease_workspace_id, workspace_id, tmux_pane, role, parent_id, pid, started, status, task, activity, model, joined_at, seen_at, tool_calls, input, cache_read, cache_write, output, cost, unpriced, session_id, cwd, branch, process_title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING RETURNING id`,
		)
		.get(
			member.id,
			team,
			workspace.leaseWorkspaceId ?? null,
			workspace.id,
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
			member.cacheWrite ?? 0,
			member.output,
			member.cost,
			member.unpriced ? 1 : 0,
			member.sessionId ?? null,
			workspace.place?.cwd ?? null,
			workspace.place?.branch ?? null,
			workspace.place?.processTitle ?? null,
		);
	if (row) events.registerMember(db, member.id, context, member.updatedAt);
	return row !== undefined;
}

/** What the retiring writer adds to an end: the `reason` it does not know falls back, and a free-text `detail`. */
export interface EndInfo {
	fallback?: string;
	detail?: string;
}

/**
 * Deletes the row of `id` and records why in its `delete` event, with the row's final numbers. The reason is the one given,
 * else the cause the parent left on the row (`setEndHint`), else `end.fallback`.
 */
export function remove(db: DatabaseSync, id: string, reason?: string, now = Date.now(), end: EndInfo = {}): void {
	const row = events.member(db, id);
	if (row) {
		const why = reason ?? hintOf(row) ?? end.fallback ?? "removed";
		const run = runs.ended(db, row, why, end.detail, now);
		events.recordMember(db, row, "delete", events.endData(db, row, why, end.detail, run), now);
	}
	db.prepare("DELETE FROM agents WHERE id = ?").run(id);
}

const hintOf = (row: Row): string | undefined => (typeof row.end_hint === "string" ? row.end_hint : undefined);

/**
 * Records on the row of `id` why its parent is ending it, for whoever retires the row. The first hint stays: a stop the
 * parent asked for is not turned into a failure by the exit it causes. No row, no write; whether one was written.
 */
export function setEndHint(db: DatabaseSync, id: string, hint: string): boolean {
	return db.prepare("UPDATE agents SET end_hint = ? WHERE id = ? AND end_hint IS NULL").run(hint, id).changes > 0;
}

/**
 * Records that agent `id` entered `state` (`stalled`) as an `update` event, once per episode: the key names the registration
 * and the heartbeat the silence began at, so every process that notices writes the same key and the second write is ignored.
 * Whether a row exists to describe; a heartbeat since moves `seen_at` and starts a new episode.
 */
export function noteState(db: DatabaseSync, id: string, state: string, now = Date.now()): boolean {
	const row = events.member(db, id);
	if (!row || typeof row.registration_id !== "string") return false;
	events.recordMember(db, row, "update", { state }, now, `${row.registration_id}:${state}:${String(row.seen_at)}`);
	return true;
}

/** The process the row of `id` names; undefined when it has no row. */
export function processOf(db: DatabaseSync, id: string): ProcessIdentity | undefined {
	const row = db.prepare("SELECT pid, started FROM agents WHERE id = ?").get(id) as Row | undefined;
	return row ? { pid: num(row.pid), ...(typeof row.started === "string" ? { started: row.started } : {}) } : undefined;
}

/** Names `process` on the row of `id`: a child's process takes over the row its parent held for it. */
export function setProcess(db: DatabaseSync, id: string, process: ProcessIdentity): void {
	db.prepare("UPDATE agents SET pid = ?, started = ? WHERE id = ?").run(process.pid, process.started ?? null, id);
}

/** The process of every agent of `team`. */
export function processes(db: DatabaseSync, team: string): MemberProcess[] {
	return (db.prepare("SELECT id, pid, started, seen_at FROM agents WHERE team = ?").all(team) as Row[]).map(processRow);
}

/** The process of every agent in the database, whatever its workspace. */
export function allProcesses(db: DatabaseSync): MemberProcess[] {
	return (db.prepare("SELECT id, pid, started, seen_at FROM agents").all() as Row[]).map(processRow);
}

/** Every agent name in the database (ids are unique across workspaces). */
export function ids(db: DatabaseSync): string[] {
	return (db.prepare("SELECT id FROM agents").all() as Row[]).map((row) => String(row.id));
}

/** The agent rows of `team`, oldest first, each with `pending`: the questions delivered to it and not yet answered (`deliveries.openQuestions`). */
export function inTeam(db: DatabaseSync, team: string): Row[] {
	return db
		.prepare(
			`SELECT a.*, w.root AS checkout, (SELECT count(*) FROM deliveries d JOIN messages m ON m.id = d.message
                      WHERE d.recipient = a.id AND d.delivered_at IS NOT NULL AND d.completed_at IS NULL AND m.reply_required = 1
                        AND d.dead_at IS NULL AND d.relay_to IS NULL) AS pending
         FROM agents a ${CHECKOUT} WHERE a.team = ? ORDER BY a.joined_at, a.id`,
		)
		.all(team);
}

/** Agents of `team` that heartbeat at or after `floor` get `seen_at` raised to at least `now`. */
export function touchSeenSince(db: DatabaseSync, team: string, floor: number, now: number): void {
	db.prepare("UPDATE agents SET seen_at = MAX(seen_at, ?) WHERE team = ? AND seen_at >= ?").run(now, team, floor);
}

/** How long this connection waits for a lock held by another process before it fails with "database is locked". */
export function setBusyTimeout(db: DatabaseSync, ms: number): void {
	db.exec(`PRAGMA busy_timeout=${ms}`);
}

/** Live presence of this checkout only; legacy/nonpersistent registrations keep their existing names. */
export function inWorkspace(db: DatabaseSync, workspace: string): Row[] {
	return db
		.prepare(`SELECT a.*, w.root AS checkout FROM agents a ${CHECKOUT} WHERE a.workspace_id = ? ORDER BY a.id`)
		.all(workspace);
}
