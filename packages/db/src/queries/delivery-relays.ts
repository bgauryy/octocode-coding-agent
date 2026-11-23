import type { DatabaseSync } from "node:sqlite";
import type { Row } from "../rows.ts";
import { keptStatement } from "../statements.ts";
import { DELIVERED_COLUMNS } from "./delivery-columns.ts";

/** Relay requests on `deliveries` (`team/relay.ts`): a parent's copy of a message it forwards to another agent. */

/** How long a claimed relay request may stay unsettled before another claim may take it over. */
export const RELAY_LEASE_MS = 60_000;

/** Turns `parent`'s delivery of `message` into a relay request for `target`. */
export function markRelay(db: DatabaseSync, message: number, parent: string, target: string, wake: number): void {
	db.prepare("UPDATE deliveries SET relay_to = ?, wake = ? WHERE message = ? AND recipient = ?").run(
		target,
		wake,
		message,
		parent,
	);
}

/** The relay requests waiting for `parent`, oldest first; `relay_to` names the agent each is for. */
export function relayRequests(db: DatabaseSync, team: string, parent: string, limit: number, now: number): Row[] {
	return keptStatement(
		db,
		`SELECT ${DELIVERED_COLUMNS}, d.relay_to
         FROM deliveries d JOIN messages m ON m.id = d.message LEFT JOIN agents s ON s.id = m.sender
         WHERE d.recipient = ? AND m.team = ? AND d.relay_to IS NOT NULL AND d.dead_at IS NULL AND
         (d.delivered_at IS NULL OR (d.completed_at IS NULL AND d.delivered_at < ?))
         ORDER BY m.id LIMIT ?`,
	).all(parent, team, now - RELAY_LEASE_MS, limit);
}

/**
 * Takes the relay request `message` for `parent`; false when it was already taken (or is gone). A claim that stays
 * unsettled for `RELAY_LEASE_MS` has lapsed and can be taken again.
 */
export function claimRelay(db: DatabaseSync, message: number, parent: string, now: number): boolean {
	return (
		db
			.prepare(
				"UPDATE deliveries SET delivered_at = ? WHERE message = ? AND recipient = ? AND relay_to IS NOT NULL AND dead_at IS NULL AND (delivered_at IS NULL OR (completed_at IS NULL AND delivered_at < ?))",
			)
			.run(now, message, parent, now - RELAY_LEASE_MS).changes > 0
	);
}

/** Settles `recipient`'s delivery of `message` as completed (the relay was handled), whether or not it was open. */
export function settle(db: DatabaseSync, message: number, recipient: string, now: number): void {
	db.prepare("UPDATE deliveries SET completed_at = ? WHERE message = ? AND recipient = ?").run(now, message, recipient);
}

/** Makes `recipient`'s delivery of `message` a settled dead letter with `reason`. */
export function failDelivery(db: DatabaseSync, message: number, recipient: string, reason: string, now: number): void {
	db.prepare(
		"UPDATE deliveries SET dead_at = ?, completed_at = COALESCE(completed_at, ?), note = ? WHERE message = ? AND recipient = ?",
	).run(now, now, reason, message, recipient);
}
