import type { DatabaseSync } from "node:sqlite";
import { allRows } from "../rows.ts";
import { keptStatement } from "../statements.ts";

/**
 * Callback tickets (`tickets`, `schema-events.ts`): a request one agent made of another, resolved at most once by a reply
 * or an event. Resolving is one conditional `UPDATE ... WHERE state = 'pending'`; SQLite's single writer makes exactly one
 * caller win across processes. `filter` and `chain` are JSON text the caller serialized; the database never reads inside them.
 */

export type TicketState = "pending" | "resolved" | "rejected" | "cancelled";

export interface TicketRow {
	id: number;
	workspace_id: string;
	session_id: string | null;
	requester: string;
	target: string;
	on_kind: string;
	/** JSON text of the filter; empty for none. */
	filter: string;
	note: string;
	/** The `messages` row that carried the request, when there is one. */
	request_message: number | null;
	text_hash: string;
	depth: number;
	/** JSON text: the ticket ids this request descends from. */
	chain: string;
	deadline: number;
	state: TicketState;
	created_at: number;
	resolved_at: number | null;
	/** The `event_log` row of `ticket.resolved` or `ticket.rejected`. */
	result_seq: number | null;
	/** Why a ticket was rejected or cancelled (`timeout`, `loop`, `left`, `cancelled`). */
	reason: string | null;
}

export interface NewTicket {
	workspaceId: string;
	sessionId?: string;
	requester: string;
	target: string;
	onKind: string;
	filter?: string;
	note?: string;
	requestMessage?: number;
	textHash: string;
	depth: number;
	chain: string;
	deadline: number;
	at: number;
	/** Most pending tickets the requester may hold, and the target may be asked for. */
	maxPerRequester: number;
	maxPerTarget: number;
}

/** How a refused insert is told apart: the limit that held. */
export type TicketOutcome = { opened: TicketRow } | { refused: "requester" | "target" };

const get = (db: DatabaseSync, id: number) =>
	keptStatement(db, "SELECT * FROM tickets WHERE id = ?").get(id) as unknown as TicketRow | undefined;

export const find = get;

/** How many tickets `requester` has pending, not counting those asked of `except` (none: every one). */
export function pendingOf(db: DatabaseSync, workspaceId: string, requester: string, except = ""): number {
	return (
		keptStatement(
			db,
			"SELECT COUNT(*) AS n FROM tickets WHERE workspace_id = ? AND requester = ? AND state = 'pending' AND target != ?",
		).get(workspaceId, requester, except) as { n: number }
	).n;
}

/** Whether any ticket in the workspace is still pending: when none is, no result can arrive and none can expire. */
export function anyPending(db: DatabaseSync, workspaceId: string): boolean {
	return (
		keptStatement(db, "SELECT 1 FROM tickets WHERE workspace_id = ? AND state = 'pending' LIMIT 1").get(workspaceId) !==
		undefined
	);
}

/** Pending `reply` tickets `requester` holds on `target`: what a report from `target` answers. */
export function pendingBetween(db: DatabaseSync, workspaceId: string, requester: string, target: string): TicketRow[] {
	return allRows<TicketRow>(
		keptStatement(
			db,
			"SELECT * FROM tickets WHERE workspace_id = ? AND requester = ? AND target = ? AND on_kind = 'reply' AND state = 'pending' ORDER BY id",
		),
		workspaceId,
		requester,
		target,
	);
}

/** Opens a ticket unless the requester or the target is at its limit; the check and the insert are one statement. */
export function open(db: DatabaseSync, ticket: NewTicket): TicketOutcome {
	const result = keptStatement(
		db,
		`INSERT INTO tickets (workspace_id, session_id, requester, target, on_kind, filter, note, request_message, text_hash,
		   depth, chain, deadline, created_at)
		 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
		 WHERE (SELECT COUNT(*) FROM tickets WHERE workspace_id = ?1 AND requester = ?3 AND state = 'pending') < ?14
		   AND (SELECT COUNT(*) FROM tickets WHERE workspace_id = ?1 AND target = ?4 AND state = 'pending') < ?15`,
	).run(
		ticket.workspaceId,
		ticket.sessionId ?? null,
		ticket.requester,
		ticket.target,
		ticket.onKind,
		ticket.filter ?? "",
		ticket.note ?? "",
		ticket.requestMessage ?? null,
		ticket.textHash,
		ticket.depth,
		ticket.chain,
		ticket.deadline,
		ticket.at,
		ticket.maxPerRequester,
		ticket.maxPerTarget,
	);
	if (Number(result.changes) > 0) {
		const row = get(db, Number(result.lastInsertRowid));
		if (!row) throw new Error("ticket insert vanished");
		return { opened: row };
	}
	return {
		refused: pendingOf(db, ticket.workspaceId, ticket.requester) >= ticket.maxPerRequester ? "requester" : "target",
	};
}

/** The pending ticket the same requester opened for the same target and text since `since`, if any. */
export function openDuplicate(
	db: DatabaseSync,
	workspaceId: string,
	requester: string,
	target: string,
	textHash: string,
	since: number,
): TicketRow | undefined {
	return keptStatement(
		db,
		`SELECT * FROM tickets WHERE workspace_id = ? AND requester = ? AND target = ? AND text_hash = ? AND state = 'pending'
		 AND created_at >= ? ORDER BY id LIMIT 1`,
	).get(workspaceId, requester, target, textHash, since) as unknown as TicketRow | undefined;
}

/** Pending tickets waiting on `target`'s reply to `message`, or on events of `onKind` when `message` is omitted. */
export function pendingFor(
	db: DatabaseSync,
	workspaceId: string,
	target: string,
	onKind: string,
	message?: number,
): TicketRow[] {
	return allRows<TicketRow>(
		keptStatement(
			db,
			`SELECT * FROM tickets WHERE workspace_id = ? AND target = ? AND on_kind = ? AND state = 'pending'
			 AND (?4 IS NULL OR request_message = ?4) ORDER BY id`,
		),
		workspaceId,
		target,
		onKind,
		message ?? null,
	);
}

/** Pending tickets of `onKind` whatever the target: the event kinds a producer resolves (`item.state`, `job.exit`). */
export function pendingOfKind(db: DatabaseSync, workspaceId: string, onKind: string): TicketRow[] {
	return allRows<TicketRow>(
		keptStatement(db, "SELECT * FROM tickets WHERE workspace_id = ? AND on_kind = ? AND state = 'pending' ORDER BY id"),
		workspaceId,
		onKind,
	);
}

/** Settles a pending ticket as `state` with the event that records it. Returns false when something settled it first. */
export function settle(
	db: DatabaseSync,
	id: number,
	state: Exclude<TicketState, "pending">,
	at: number,
	resultSeq: number | null,
	reason?: string,
): boolean {
	return (
		Number(
			keptStatement(
				db,
				"UPDATE tickets SET state = ?, resolved_at = ?, result_seq = ?, reason = ? WHERE id = ? AND state = 'pending'",
			).run(state, at, resultSeq, reason ?? null, id).changes,
		) > 0
	);
}

/** Records the `event_log` row of a ticket's result once the event is appended. */
export function recordResult(db: DatabaseSync, id: number, resultSeq: number): void {
	keptStatement(db, "UPDATE tickets SET result_seq = ? WHERE id = ? AND state != 'pending'").run(resultSeq, id);
}

/** Pending tickets past their deadline at `now`, oldest first. */
export function overdue(db: DatabaseSync, workspaceId: string, now: number): TicketRow[] {
	return allRows<TicketRow>(
		keptStatement(
			db,
			"SELECT * FROM tickets WHERE workspace_id = ? AND state = 'pending' AND deadline <= ? ORDER BY id",
		),
		workspaceId,
		now,
	);
}

/** Pending tickets `agent` holds as requester or target: what leaving cancels. */
export function pendingInvolving(db: DatabaseSync, workspaceId: string, agent: string): TicketRow[] {
	return allRows<TicketRow>(
		keptStatement(
			db,
			"SELECT * FROM tickets WHERE workspace_id = ?1 AND (requester = ?2 OR target = ?2) AND state = 'pending' ORDER BY id",
		),
		workspaceId,
		agent,
	);
}

/** Retention: deletes the settled tickets created before `cutoff`, and pending ones past their deadline by then. */
export function purgeBefore(db: DatabaseSync, cutoff: number): number {
	return Number(
		db.prepare("DELETE FROM tickets WHERE created_at < ?1 AND (state != 'pending' OR deadline < ?1)").run(cutoff)
			.changes,
	);
}
