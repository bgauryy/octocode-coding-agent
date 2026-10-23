import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../../agentdb/rows.ts";
import type { Ask } from "../asks.ts";
import {
	type DeadLetter,
	type Message,
	type SendOptions,
	type Traffic,
	toAsk,
	toMessage,
	toTraffic,
	WAKE,
} from "../model.ts";
import { INBOX_BATCH_SIZE } from "./limits.ts";

/** The message rows behind `TeamStore` (`store.ts`); each is described on the `TeamStore` method that runs it. */

/** Makes the `proof` of message `id` for `recipient` (see `userProof`); undefined for a recipient the caller cannot sign for. */
export type SignProof = (id: number, recipient: string) => string | undefined;

export function insertMessage(
	db: DatabaseSync,
	workspace: string,
	/** The recipients that can still read mail (`TeamStore.reachable`), read in the same transaction. */
	live: Set<string>,
	from: string,
	to: string[],
	body: string,
	options: SendOptions & { replyRequired: boolean; wake?: boolean; sign?: SignProof },
	now: number,
): { id: number | undefined; departed: string[] } {
	const departed = to.filter((recipient) => !live.has(recipient));
	const recipients = to.filter((recipient) => live.has(recipient));
	if (recipients.length === 0) return { id: undefined, departed };
	// The asker is woken by the answer to its own open question, never by a reply to an FYI or a thank-you.
	let asker: string | undefined;
	let completesReply = false;
	if (options.replyTo !== undefined) {
		const question = replyTarget(db, workspace, options.replyTo);
		const open = db
			.prepare("SELECT 1 FROM deliveries WHERE message = ? AND recipient = ? AND completed_at IS NULL")
			.get(options.replyTo, from);
		if (question?.replyRequired && open !== undefined) asker = question.from;
		completesReply = question !== undefined && recipients.includes(question.from);
	}
	const { lastInsertRowid } = db
		.prepare(
			"INSERT INTO messages (workspace, sender, body, reply_required, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(workspace, from, body, options.replyRequired ? 1 : 0, options.replyTo ?? null, now);
	const id = Number(lastInsertRowid);
	const insert = db.prepare("INSERT INTO deliveries (message, recipient, wake, proof) VALUES (?, ?, ?, ?)");
	for (const recipient of recipients) {
		const wake = options.interrupt
			? WAKE.interrupt
			: options.wake || options.replyRequired || recipient === asker
				? WAKE.wake
				: WAKE.none;
		insert.run(id, recipient, wake, options.sign?.(id, recipient) ?? null);
	}
	if (options.replyTo !== undefined && completesReply)
		db.prepare(
			"UPDATE deliveries SET completed_at = ? WHERE message = ? AND recipient = ? AND completed_at IS NULL",
		).run(now, options.replyTo, from);
	return { id, departed };
}

export function replyTarget(
	db: DatabaseSync,
	workspace: string,
	id: number,
): { from: string; replyRequired: boolean } | undefined {
	const row = db
		.prepare("SELECT sender, reply_required FROM messages WHERE id = ? AND workspace = ?")
		.get(id, workspace) as Row | undefined;
	return row ? { from: String(row.sender), replyRequired: row.reply_required === 1 } : undefined;
}

export function asks(db: DatabaseSync, workspace: string, child: string, parent: string, since: number): Ask[] {
	const rows = db
		.prepare(
			`SELECT m.id, m.body, m.created_at, r.id AS reply_id, r.created_at AS reply_at, r.sender AS reply_by
         FROM messages m JOIN deliveries d ON d.message = m.id AND d.recipient = ?
         LEFT JOIN messages r ON r.id = (
           SELECT min(reply.id) FROM messages reply
           JOIN deliveries receipt ON receipt.message = reply.id AND receipt.recipient = m.sender
           WHERE reply.reply_to = m.id AND reply.sender = d.recipient)
         WHERE m.workspace = ? AND m.sender = ? AND m.reply_required = 1 AND m.created_at >= ? ORDER BY m.id`,
		)
		.all(parent, workspace, child, since) as Row[];
	return rows.map(toAsk);
}

export function deadLetters(
	db: DatabaseSync,
	workspace: string,
	sender: string,
	limit = INBOX_BATCH_SIZE,
): DeadLetter[] {
	const rows = db
		.prepare(
			`SELECT m.id, m.body, d.recipient FROM deliveries d JOIN messages m ON m.id = d.message
         WHERE m.workspace = ? AND m.sender = ? AND d.dead_at IS NOT NULL AND d.notified_at IS NULL ORDER BY m.id, d.recipient LIMIT ?`,
		)
		.all(workspace, sender, limit) as Row[];
	const letters = new Map<number, DeadLetter>();
	for (const row of rows) {
		const id = num(row.id);
		const letter = letters.get(id) ?? { id, recipients: [], text: String(row.body) };
		letter.recipients.push(String(row.recipient));
		letters.set(id, letter);
	}
	return [...letters.values()];
}

export function waiting(db: DatabaseSync, workspace: string, id: string, after = 0): number {
	return num(
		(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM deliveries WHERE recipient = ? AND message > ? AND delivered_at IS NULL AND dead_at IS NULL",
				)
				.get(id, after) as Row
		).n,
	);
}

export function waitingThrough(db: DatabaseSync, workspace: string, id: string, through: number): number[] {
	const rows = db
		.prepare(
			"SELECT message FROM deliveries WHERE recipient = ? AND message <= ? AND delivered_at IS NULL AND dead_at IS NULL",
		)
		.all(id, through) as Row[];
	return rows.map((row) => num(row.message));
}

export function pending(db: DatabaseSync, workspace: string, id: string, after = 0): Message[] {
	const rows = db
		.prepare(
			`SELECT m.id, m.sender, m.body, m.created_at, m.reply_required, m.reply_to, d.wake, d.proof, s.role AS sender_role, s.task AS sender_goal
         FROM deliveries d JOIN messages m ON m.id = d.message LEFT JOIN agents s ON s.id = m.sender
         WHERE d.recipient = ? AND d.message > ? AND d.delivered_at IS NULL AND d.dead_at IS NULL ORDER BY m.id LIMIT ?`,
		)
		.all(id, after, INBOX_BATCH_SIZE) as Row[];
	return rows.map((row) => toMessage(row, id));
}

export function pendingUrgent(
	db: DatabaseSync,
	workspace: string,
	id: string,
	after: number,
	idle: boolean,
): Message | undefined {
	const row = db
		.prepare(
			`SELECT m.id, m.sender, m.body, m.created_at, m.reply_required, m.reply_to, d.wake, d.proof, s.role AS sender_role, s.task AS sender_goal
         FROM deliveries d JOIN messages m ON m.id = d.message LEFT JOIN agents s ON s.id = m.sender
         WHERE d.recipient = ? AND d.message > ? AND d.delivered_at IS NULL AND d.dead_at IS NULL AND d.wake >= ? ORDER BY m.id LIMIT 1`,
		)
		.get(id, after, idle ? WAKE.wake : WAKE.interrupt) as Row | undefined;
	return row ? toMessage(row, id) : undefined;
}

export function recent(
	db: DatabaseSync,
	workspace: string,
	limit = 30,
	now = Date.now(),
	windowMs = 10 * 60_000,
): Traffic[] {
	const rows = db
		.prepare("SELECT * FROM messages WHERE workspace = ? AND created_at > ? ORDER BY id DESC LIMIT ?")
		.all(workspace, now - windowMs, limit) as Row[];
	const deliveries = db.prepare(
		"SELECT recipient, delivered_at, completed_at, dead_at FROM deliveries WHERE message = ? ORDER BY recipient",
	);
	return rows.map((row) => toTraffic(row, deliveries.all(num(row.id)) as Row[]));
}

/** Deletes messages past retention whose deliveries are all settled (`TeamStore.prune`). */
export function pruneMessages(db: DatabaseSync, before: number): void {
	db.prepare(
		`DELETE FROM messages WHERE created_at < ? AND NOT EXISTS (
      SELECT 1 FROM deliveries d WHERE d.message = messages.id AND d.completed_at IS NULL
        AND (d.dead_at IS NULL OR d.notified_at IS NULL)
    )`,
	).run(before);
}

export function markNotified(db: DatabaseSync, letters: DeadLetter[], now: number): void {
	const mark = db.prepare(
		"UPDATE deliveries SET notified_at = ? WHERE message = ? AND recipient = ? AND dead_at IS NOT NULL",
	);
	for (const letter of letters) for (const recipient of letter.recipients) mark.run(now, letter.id, recipient);
}

export function markDelivered(db: DatabaseSync, id: string, messageIds: number[], now: number): void {
	const mark = db.prepare(
		"UPDATE deliveries SET delivered_at = ?, completed_at = CASE WHEN (SELECT reply_required FROM messages WHERE id = ?) = 1 THEN completed_at ELSE COALESCE(completed_at, ?) END WHERE message = ? AND recipient = ? AND delivered_at IS NULL",
	);
	for (const message of messageIds) mark.run(now, message, now, message, id);
}
