import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../../agentdb/rows.ts";
import { sameProcess } from "../../shared/process.ts";
import { optionalString } from "../../shared/util.ts";
import { type Lease, toMember } from "../model.ts";
import { STALE_MS, stale } from "./limits.ts";
import type { Member } from "@octocodeai/octocode-contacts/team";

/** The process a member row names: the pid and, where known, its start time, so a reused pid is not taken for it. */
export interface ProcessIdentity {
	pid: number;
	started?: string | undefined;
}

const sameIdentity = (a: ProcessIdentity, b: ProcessIdentity): boolean =>
	a.pid === b.pid && (a.started ?? null) === (b.started ?? null);

/** The heartbeat's `UPDATE`: matches the row only while it still names this process. */
export function refreshMember(db: DatabaseSync, member: Member): boolean {
	const { changes } = db
		.prepare(
			`UPDATE agents SET status = ?, task = ?, activity = ?, model = ?, seen_at = ?, tool_calls = ?, input = ?, cache_read = ?, output = ?, cost = ?, unpriced = ?
         WHERE id = ? AND pid = ? AND started IS ?`,
		)
		.run(
			member.status,
			member.goal ?? null,
			member.activity ?? null,
			member.model ?? null,
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

/** Adds the row unless the id is taken (`ON CONFLICT DO NOTHING`, so a name held by another process is never overwritten); whether it was added. */
export function insertMember(db: DatabaseSync, workspace: string, member: Member): boolean {
	const row = db
		.prepare(
			`INSERT INTO agents (id, workspace, role, parent_id, pid, started, status, task, activity, model, joined_at, seen_at, tool_calls, input, cache_read, output, cost, unpriced)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING RETURNING id`,
		)
		.get(
			member.id,
			workspace,
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
		);
	return row !== undefined;
}

/** The process the row of `id` names; undefined when it has no row. */
export function processOf(db: DatabaseSync, id: string): ProcessIdentity | undefined {
	const row = db.prepare("SELECT pid, started FROM agents WHERE id = ?").get(id) as Row | undefined;
	return row ? { pid: num(row.pid), started: optionalString(row.started) } : undefined;
}

/** Deletes the row, releases the leases and dead-letters the unread mail of `id`; the one place a member is dropped. */
function retire(db: DatabaseSync, id: string, now: number): void {
	db.prepare("DELETE FROM agents WHERE id = ?").run(id);
	db.prepare("DELETE FROM leases WHERE owner = ?").run(id);
	db.prepare("UPDATE deliveries SET dead_at = ? WHERE recipient = ? AND delivered_at IS NULL AND dead_at IS NULL").run(
		now,
		id,
	);
}

/** `join`'s write, run in its transaction: takes the name unless a running process other than this one holds it. */
export function claimMember(db: DatabaseSync, workspace: string, member: Member): boolean {
	if (insertMember(db, workspace, member) || refreshMember(db, member)) return true;
	const holder = processOf(db, member.id);
	if (holder && sameProcess(holder.pid, holder.started)) return false;
	retire(db, member.id, Date.now());
	return insertMember(db, workspace, member);
}

/** Retires `id` unless its row now names another process than `owner` (`TeamStore.remove`); whether it did. */
export function retireOwned(db: DatabaseSync, id: string, now: number, owner: ProcessIdentity | undefined): boolean {
	if (owner) {
		const row = processOf(db, id);
		if (row && !sameIdentity(row, owner)) return false;
	}
	retire(db, id, now);
	return true;
}

/** Retires `id` if its row still names `judged` (`TeamStore.reap`); whether it did. */
export function reapMember(db: DatabaseSync, id: string, judged: ProcessIdentity | undefined, now: number): boolean {
	const row = processOf(db, id);
	if (row && (judged === undefined || !sameIdentity(row, judged))) return false;
	retire(db, id, now);
	return true;
}

/** Members still live at `since` (by heartbeat) get a fresh start from `now` (`TeamStore.resume`). */
export function resumeMembers(db: DatabaseSync, workspace: string, since: number, now: number): void {
	db.prepare("UPDATE agents SET seen_at = MAX(seen_at, ?) WHERE workspace = ? AND seen_at >= ?").run(
		now,
		workspace,
		since - STALE_MS,
	);
}

/**
 * The visible members of `workspace` (`TeamStore.list`): the agent rows are read first, then the live leases
 * (`leases`), whose paths each member holds are added as its `locks`.
 */
export function listMembers(db: DatabaseSync, workspace: string, now: number, leases: () => Lease[]): Member[] {
	const rows = db
		.prepare(
			`SELECT a.*, (SELECT count(*) FROM deliveries d JOIN messages m ON m.id = d.message
                      WHERE d.recipient = a.id AND d.delivered_at IS NOT NULL AND d.completed_at IS NULL AND m.reply_required = 1) AS pending
         FROM agents a WHERE a.workspace = ? ORDER BY a.joined_at, a.id`,
		)
		.all(workspace) as Row[];
	const live = rows
		.map(toMember)
		.filter((member) => !stale(member.updatedAt, now) && sameProcess(member.pid, member.started, now));
	const held = leases();
	return live.map((member) => {
		const locks = held
			.filter((lease) => lease.owner === member.id)
			.map((lease) => (lease.kind === "tree" ? `${lease.path}/` : lease.path));
		return locks.length > 0 ? { ...member, locks } : member;
	});
}

/** Ids of `workspace`'s agents whose process runs (`TeamStore.reachable`). */
export function reachableMembers(db: DatabaseSync, workspace: string): Set<string> {
	const rows = db.prepare("SELECT id, pid, started FROM agents WHERE workspace = ?").all(workspace) as Row[];
	const now = Date.now();
	return new Set(
		rows.filter((row) => sameProcess(num(row.pid), optionalString(row.started), now)).map((row) => String(row.id)),
	);
}
