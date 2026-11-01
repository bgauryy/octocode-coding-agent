import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../rows.ts";

/** The `messages` and `deliveries` tables: a message is immutable, a delivery is one recipient's copy and state of it. */

/** The columns `toMessage` reads from a delivery joined with its message (`m`) and the sender's agent row (`s`). */
const DELIVERED_COLUMNS =
	"m.id, m.sender, m.body, m.created_at, m.reply_required, m.reply_to, d.wake, d.proof, d.forwarded_by, d.note, s.role AS sender_role, s.task AS sender_goal";

// ── messages ──────────────────────────────────────────────────────────────

/** Stores a message; its id. */
export function insertMessage(
	db: DatabaseSync,
	team: string,
	from: string,
	body: string,
	replyRequired: boolean,
	replyTo: number | undefined,
	now: number,
): number {
	const { lastInsertRowid } = db
		.prepare(
			"INSERT INTO messages (workspace, sender, body, reply_required, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		)
		.run(team, from, body, replyRequired ? 1 : 0, replyTo ?? null, now);
	return Number(lastInsertRowid);
}

/** The sender of message `id` in `team` and whether it asked for a reply; undefined when there is no such message. */
export function replyTarget(
	db: DatabaseSync,
	team: string,
	id: number,
): { from: string; replyRequired: boolean } | undefined {
	const row = db.prepare("SELECT sender, reply_required FROM messages WHERE id = ? AND workspace = ?").get(id, team) as
		| Row
		| undefined;
	return row ? { from: String(row.sender), replyRequired: row.reply_required === 1 } : undefined;
}

/** Whether message `id` exists in `team`. */
export function messageExists(db: DatabaseSync, team: string, id: number): boolean {
	return db.prepare("SELECT 1 FROM messages WHERE id = ? AND workspace = ?").get(id, team) !== undefined;
}

/** Message `id` of `team`; undefined when it has no row. */
export function messageRow(db: DatabaseSync, team: string, id: number): Row | undefined {
	return db
		.prepare(
			"SELECT id, sender, body, created_at, reply_required, reply_to FROM messages WHERE id = ? AND workspace = ?",
		)
		.get(id, team);
}

/** The highest message id handed out (ids only grow: AUTOINCREMENT), or 0 before the first. */
export function lastMessageId(db: DatabaseSync): number {
	return num((db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").get() as Row | undefined)?.seq);
}

/** Points message `id` at the message it answers. */
export function setReplyTo(db: DatabaseSync, id: number, replyTo: number): void {
	db.prepare("UPDATE messages SET reply_to = ? WHERE id = ?").run(replyTo, id);
}

/** Deletes message `id` of `team` with its deliveries. */
export function deleteMessage(db: DatabaseSync, team: string, id: number): void {
	db.prepare("DELETE FROM messages WHERE id = ? AND workspace = ?").run(id, team);
}

/**
 * Deletes messages created before `before` whose deliveries are all settled. A dead letter not yet reported counts as
 * settled once its sender has no agent row: only the sender's own session reports it (`team/mail.ts`), so it never would.
 */
export function pruneMessages(db: DatabaseSync, before: number): void {
	db.prepare(
		`DELETE FROM messages WHERE created_at < ? AND NOT EXISTS (
      SELECT 1 FROM deliveries d WHERE d.message = messages.id AND d.completed_at IS NULL
        AND (d.dead_at IS NULL OR (d.notified_at IS NULL AND EXISTS (SELECT 1 FROM agents a WHERE a.id = messages.sender)))
    )`,
	).run(before);
}

/** The messages of `team` created after `since`, newest first, each with its deliveries' state. */
export function recentTraffic(
	db: DatabaseSync,
	team: string,
	since: number,
	limit: number,
): Array<{ message: Row; deliveries: Row[] }> {
	const rows = db
		.prepare("SELECT * FROM messages WHERE workspace = ? AND created_at > ? ORDER BY id DESC LIMIT ?")
		.all(team, since, limit) as Row[];
	const deliveries = db.prepare(
		"SELECT recipient, delivered_at, completed_at, dead_at FROM deliveries WHERE message = ? ORDER BY recipient",
	);
	return rows.map((message) => ({ message, deliveries: deliveries.all(num(message.id)) as Row[] }));
}

/**
 * The questions `child` sent `parent` since `since`, oldest first, each with the parent's first reply. A relay row is
 * addressed to the parent but asks the agent in `relay_to`, so it is a peer ask (`unansweredAsks`), not one of these.
 */
export function asks(db: DatabaseSync, team: string, child: string, parent: string, since: number): Row[] {
	return db
		.prepare(
			`SELECT m.id, m.body, m.created_at, r.id AS reply_id, r.created_at AS reply_at, r.sender AS reply_by
         FROM messages m JOIN deliveries d ON d.message = m.id AND d.recipient = ? AND d.relay_to IS NULL
         LEFT JOIN messages r ON r.id = (
           SELECT min(reply.id) FROM messages reply
           JOIN deliveries receipt ON receipt.message = reply.id AND receipt.recipient = m.sender
           WHERE reply.reply_to = m.id AND reply.sender = d.recipient)
         WHERE m.workspace = ? AND m.sender = ? AND m.reply_required = 1 AND m.created_at >= ? ORDER BY m.id`,
		)
		.all(parent, team, child, since);
}

/**
 * How many `replyRequired` questions `sender` sent to agents other than `except` are still unanswered: no reply from that
 * recipient yet, and the recipient has not left (a pending relay counts for the agent it is for).
 */
export function unansweredAsks(db: DatabaseSync, team: string, sender: string, except: string): number {
	return num(
		(
			db
				.prepare(
					`SELECT COUNT(*) AS n FROM deliveries d JOIN messages m ON m.id = d.message
             WHERE m.workspace = ? AND m.sender = ? AND m.reply_required = 1 AND d.completed_at IS NULL AND d.dead_at IS NULL
               AND COALESCE(d.relay_to, d.recipient) != ?
               AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id AND r.sender = COALESCE(d.relay_to, d.recipient))`,
				)
				.get(team, sender, except) as Row
		).n,
	);
}

// ── deliveries ────────────────────────────────────────────────────────────

export interface NewDelivery {
	message: number;
	recipient: string;
	wake: number;
	proof?: string | undefined;
	forwardedBy?: string | undefined;
	note?: string | undefined;
}

/** Adds a delivery; with `ignoreExisting` a recipient that already holds one is left as it is. */
export function insertDelivery(db: DatabaseSync, delivery: NewDelivery, ignoreExisting = false): void {
	db.prepare(
		`INSERT ${ignoreExisting ? "OR IGNORE " : ""}INTO deliveries (message, recipient, wake, proof, forwarded_by, note) VALUES (?, ?, ?, ?, ?, ?)`,
	).run(
		delivery.message,
		delivery.recipient,
		delivery.wake,
		delivery.proof ?? null,
		delivery.forwardedBy ?? null,
		delivery.note ?? null,
	);
}

/** Whether `recipient` holds a delivery of `message`. */
export function holds(db: DatabaseSync, message: number, recipient: string): boolean {
	return (
		db.prepare("SELECT 1 FROM deliveries WHERE message = ? AND recipient = ?").get(message, recipient) !== undefined
	);
}

/** Whether `recipient` holds a delivery of `message` it has not completed. */
export function holdsOpen(db: DatabaseSync, message: number, recipient: string): boolean {
	return (
		db
			.prepare("SELECT 1 FROM deliveries WHERE message = ? AND recipient = ? AND completed_at IS NULL")
			.get(message, recipient) !== undefined
	);
}

/** The deliveries of message `id` by recipient: `recipient` and `forwarded_by`. */
export function recipientsOf(db: DatabaseSync, id: number): Row[] {
	return db.prepare("SELECT recipient, forwarded_by FROM deliveries WHERE message = ? ORDER BY recipient").all(id);
}

/** Removes `recipient`'s delivery of `message`. */
export function deleteDelivery(db: DatabaseSync, message: number, recipient: string): void {
	db.prepare("DELETE FROM deliveries WHERE message = ? AND recipient = ?").run(message, recipient);
}

/** Completes `recipient`'s open delivery of `message` (an answer to it was sent). */
export function complete(db: DatabaseSync, message: number, recipient: string, now: number): void {
	db.prepare("UPDATE deliveries SET completed_at = ? WHERE message = ? AND recipient = ? AND completed_at IS NULL").run(
		now,
		message,
		recipient,
	);
}

/** Marks `recipient`'s deliveries of `messageIds` delivered; a message that needs no reply is complete with it. */
export function markDelivered(db: DatabaseSync, recipient: string, messageIds: number[], now: number): void {
	const mark = db.prepare(
		"UPDATE deliveries SET delivered_at = ?, completed_at = CASE WHEN (SELECT reply_required FROM messages WHERE id = ?) = 1 THEN completed_at ELSE COALESCE(completed_at, ?) END WHERE message = ? AND recipient = ? AND delivered_at IS NULL",
	);
	for (const message of messageIds) mark.run(now, message, now, message, recipient);
}

/**
 * Closes the open `replyRequired` questions `sender` asked (deliveries read or not; relay requests stay for the parent to
 * settle), unless `sender` is a subagent whose parent still has a row: that parent may resume it with the answer.
 * Run before the sender's row is removed.
 */
export function closeAsksOf(db: DatabaseSync, sender: string, now: number): void {
	db.prepare(
		`UPDATE deliveries SET completed_at = ? WHERE completed_at IS NULL AND dead_at IS NULL AND relay_to IS NULL
       AND message IN (SELECT id FROM messages WHERE sender = ? AND reply_required = 1)
       AND NOT EXISTS (SELECT 1 FROM agents a JOIN agents p ON p.id = a.parent_id WHERE a.id = ?)`,
	).run(now, sender, sender);
}

/**
 * The questions read and not yet answered in `team`, oldest first: recipient, message id, sender, body and time. The
 * same rows `agents.inTeam` counts as `pending`; relay requests are the parent's errand, not questions to it.
 */
export function openQuestions(db: DatabaseSync, team: string): Row[] {
	return db
		.prepare(
			`SELECT d.recipient, m.id, m.sender, m.body, m.created_at FROM deliveries d JOIN messages m ON m.id = d.message
         WHERE m.workspace = ? AND m.reply_required = 1 AND d.delivered_at IS NOT NULL AND d.completed_at IS NULL
           AND d.dead_at IS NULL AND d.relay_to IS NULL
         ORDER BY m.id`,
		)
		.all(team);
}

/** Dead-letters `id`'s unread mail, and its read but unanswered questions and the relay requests it took but never settled. */
export function deadLetterOf(db: DatabaseSync, id: string, now: number): void {
	db.prepare("UPDATE deliveries SET dead_at = ? WHERE recipient = ? AND delivered_at IS NULL AND dead_at IS NULL").run(
		now,
		id,
	);
	db.prepare(
		`UPDATE deliveries SET dead_at = ? WHERE recipient = ? AND delivered_at IS NOT NULL AND completed_at IS NULL
       AND dead_at IS NULL AND (relay_to IS NOT NULL OR message IN (SELECT id FROM messages WHERE reply_required = 1))`,
	).run(now, id);
}

/** Dead deliveries of `sender`'s messages not yet reported to it, oldest first. */
export function deadLetters(db: DatabaseSync, team: string, sender: string, limit: number): Row[] {
	return db
		.prepare(
			`SELECT m.id, m.body, d.recipient, d.delivered_at, d.relay_to, d.note FROM deliveries d JOIN messages m ON m.id = d.message
         WHERE m.workspace = ? AND m.sender = ? AND d.dead_at IS NOT NULL AND d.notified_at IS NULL ORDER BY m.id, d.recipient LIMIT ?`,
		)
		.all(team, sender, limit);
}

/** Records that the senders were told of the dead deliveries of these (message, recipient) pairs. */
export function markNotified(
	db: DatabaseSync,
	letters: Array<{ id: number; recipients: string[] }>,
	now: number,
): void {
	const mark = db.prepare(
		"UPDATE deliveries SET notified_at = ? WHERE message = ? AND recipient = ? AND dead_at IS NOT NULL",
	);
	for (const letter of letters) for (const recipient of letter.recipients) mark.run(now, letter.id, recipient);
}

// ── inbox ─────────────────────────────────────────────────────────────────

/** How many messages after `after` wait undelivered for `id` (relay requests are for the parent process, not counted). */
export function countWaiting(db: DatabaseSync, id: string, after: number): number {
	return num(
		(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM deliveries WHERE recipient = ? AND message > ? AND delivered_at IS NULL AND dead_at IS NULL AND relay_to IS NULL",
				)
				.get(id, after) as Row
		).n,
	);
}

/** The ids of the messages up to `through` that wait undelivered for `id`. */
export function waitingIds(db: DatabaseSync, id: string, through: number): number[] {
	const rows = db
		.prepare(
			"SELECT message FROM deliveries WHERE recipient = ? AND message <= ? AND delivered_at IS NULL AND dead_at IS NULL AND relay_to IS NULL",
		)
		.all(id, through) as Row[];
	return rows.map((row) => num(row.message));
}

/** Up to `limit` undelivered messages after `after` for `id`, oldest first. Relay requests (`relay_to`) are for the parent process, never its model: skipped. */
export function waiting(db: DatabaseSync, id: string, after: number, limit: number): Row[] {
	return db
		.prepare(
			`SELECT ${DELIVERED_COLUMNS}
         FROM deliveries d JOIN messages m ON m.id = d.message LEFT JOIN agents s ON s.id = m.sender
         WHERE d.recipient = ? AND d.message > ? AND d.delivered_at IS NULL AND d.dead_at IS NULL AND d.relay_to IS NULL ORDER BY m.id LIMIT ?`,
		)
		.all(id, after, limit);
}

/** The oldest undelivered message after `after` for `id` whose `wake` is at least `minWake`. */
export function urgent(db: DatabaseSync, id: string, after: number, minWake: number): Row | undefined {
	return db
		.prepare(
			`SELECT ${DELIVERED_COLUMNS}
         FROM deliveries d JOIN messages m ON m.id = d.message LEFT JOIN agents s ON s.id = m.sender
         WHERE d.recipient = ? AND d.message > ? AND d.delivered_at IS NULL AND d.dead_at IS NULL AND d.relay_to IS NULL AND d.wake >= ? ORDER BY m.id LIMIT 1`,
		)
		.get(id, after, minWake);
}

// ── relay (`team/relay.ts`) ───────────────────────────────────────────────

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
export function relayRequests(db: DatabaseSync, team: string, parent: string, limit: number): Row[] {
	return db
		.prepare(
			`SELECT ${DELIVERED_COLUMNS}, d.relay_to
         FROM deliveries d JOIN messages m ON m.id = d.message LEFT JOIN agents s ON s.id = m.sender
         WHERE d.recipient = ? AND m.workspace = ? AND d.relay_to IS NOT NULL AND d.delivered_at IS NULL AND d.dead_at IS NULL
         ORDER BY m.id LIMIT ?`,
		)
		.all(parent, team, limit);
}

/** Takes the relay request `message` for `parent`; false when it was already taken (or is gone). */
export function claimRelay(db: DatabaseSync, message: number, parent: string, now: number): boolean {
	return (
		db
			.prepare(
				"UPDATE deliveries SET delivered_at = ? WHERE message = ? AND recipient = ? AND relay_to IS NOT NULL AND delivered_at IS NULL AND dead_at IS NULL",
			)
			.run(now, message, parent).changes > 0
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
