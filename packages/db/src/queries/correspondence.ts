import type { DatabaseSync } from "node:sqlite";
import type { Row } from "../rows.ts";
import { withDeliveries } from "./deliveries.ts";

/** What `me` and `other` exchanged in `team` since `since`: whether any message went either way, and whether mail `me` sent `other` became a dead letter (unread, or a question left unanswered). */
export interface Correspondence {
	exchanged: boolean;
	dead: boolean;
}

/**
 * Whether `other` is someone `me` corresponded with (mail sent to it or received from it, relay requests aside), the peers
 * whose ending `me` should hear of, and whether mail `me` sent it is dead, which its dead-letter notice already reports.
 * Messages older than `since` (an earlier run of the same name) do not count.
 */
export function between(db: DatabaseSync, team: string, me: string, other: string, since: number): Correspondence {
	const exchanged = db
		.prepare(
			`SELECT 1 FROM messages m JOIN deliveries d ON d.message = m.id
         WHERE m.team = ? AND d.relay_to IS NULL AND m.created_at >= ?
           AND ((m.sender = ? AND d.recipient = ?) OR (m.sender = ? AND d.recipient = ?)) LIMIT 1`,
		)
		.get(team, since, me, other, other, me);
	const dead = db
		.prepare(
			`SELECT 1 FROM messages m JOIN deliveries d ON d.message = m.id
         WHERE m.team = ? AND m.sender = ? AND d.recipient = ? AND d.relay_to IS NULL AND d.dead_at IS NOT NULL
           AND m.created_at >= ? LIMIT 1`,
		)
		.get(team, me, other, since);
	return { exchanged: exchanged !== undefined, dead: dead !== undefined };
}

/** The messages created at or after `since` that one of `agentIds` sent or received, oldest first, each with its deliveries' state. */
export function involving(
	db: DatabaseSync,
	agentIds: readonly string[],
	since: number,
): Array<{ message: Row; deliveries: Row[] }> {
	if (agentIds.length === 0) return [];
	const marks = agentIds.map(() => "?").join(", ");
	const rows = db
		.prepare(
			`SELECT * FROM messages WHERE created_at >= ?
			 AND (sender IN (${marks}) OR id IN (SELECT message FROM deliveries WHERE recipient IN (${marks}))) ORDER BY id`,
		)
		.all(since, ...agentIds, ...agentIds) as Row[];
	return withDeliveries(db, rows);
}
