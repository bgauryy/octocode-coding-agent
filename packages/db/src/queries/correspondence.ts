import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../rows.ts";

/** What `me` and `other` exchanged in `team` since `since`: whether any message went either way, and whether `me` still had a question to `other` that its leaving left unanswered. */
export interface Correspondence {
	exchanged: boolean;
	asked: boolean;
}

/**
 * Whether `other` is someone `me` corresponded with (mail sent to it or received from it, relay requests aside) and whether
 * a `replyRequired` question `me` put to it has no reply: those are the peers whose ending `me` should hear of (design
 * B36 §7). Messages older than `since` (an earlier run of the same name) do not count.
 */
export function between(db: DatabaseSync, team: string, me: string, other: string, since: number): Correspondence {
	const exchanged = db
		.prepare(
			`SELECT 1 FROM messages m JOIN deliveries d ON d.message = m.id
         WHERE m.team = ? AND d.relay_to IS NULL AND m.created_at >= ?
           AND ((m.sender = ? AND d.recipient = ?) OR (m.sender = ? AND d.recipient = ?)) LIMIT 1`,
		)
		.get(team, since, me, other, other, me);
	const open = db
		.prepare(
			`SELECT COUNT(*) AS n FROM messages m JOIN deliveries d ON d.message = m.id
         WHERE m.team = ? AND m.sender = ? AND d.recipient = ? AND m.reply_required = 1 AND d.relay_to IS NULL AND m.created_at >= ?
           AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id AND r.sender = d.recipient)`,
		)
		.get(team, me, other, since);
	return { exchanged: exchanged !== undefined, asked: num(open?.n) > 0 };
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
	const deliveries = db.prepare(
		"SELECT recipient, delivered_at, completed_at, dead_at, relay_to FROM deliveries WHERE message = ? ORDER BY recipient",
	);
	return rows.map((message) => ({ message, deliveries: deliveries.all(num(message.id)) as Row[] }));
}
