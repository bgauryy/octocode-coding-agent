import type { DatabaseSync } from "node:sqlite";
import { num, type Row } from "../rows.ts";
import { DELIVERED_COLUMNS } from "./delivery-columns.ts";

export * from "./delivery-relays.ts";

/** The `messages` and `deliveries` tables: a message is immutable, a delivery is one recipient's copy and state of it. */

/** Stores a message; its id. */
export function insertMessage(
	db: DatabaseSync,
	team: string,
	workspaceId: string,
	from: string,
	body: string,
	replyRequired: boolean,
	replyTo: number | undefined,
	now: number,
): number {
	const { lastInsertRowid } = db
		.prepare(
			"INSERT INTO messages (team, workspace_id, sender, body, reply_required, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
		.run(team, workspaceId, from, body, replyRequired ? 1 : 0, replyTo ?? null, now);
	return Number(lastInsertRowid);
}

/** The sender of message `id` in `team` and whether it asked for a reply; undefined when there is no such message. */
export function replyTarget(
	db: DatabaseSync,
	team: string,
	id: number,
): { from: string; replyRequired: boolean } | undefined {
	const row = db.prepare("SELECT sender, reply_required FROM messages WHERE id = ? AND team = ?").get(id, team) as
		| Row
		| undefined;
	return row ? { from: String(row.sender), replyRequired: row.reply_required === 1 } : undefined;
}

export function messageExists(db: DatabaseSync, team: string, id: number): boolean {
	return db.prepare("SELECT 1 FROM messages WHERE id = ? AND team = ?").get(id, team) !== undefined;
}

/** Message `id` of `team`; undefined when it has no row. */
export function messageRow(db: DatabaseSync, team: string, id: number): Row | undefined {
	return db
		.prepare("SELECT id, sender, body, created_at, reply_required, reply_to FROM messages WHERE id = ? AND team = ?")
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

export function deleteMessage(db: DatabaseSync, team: string, id: number): void {
	db.prepare("DELETE FROM messages WHERE id = ? AND team = ?").run(id, team);
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

/** Each of `messages` (rows of `messages`) with its deliveries' state, by recipient. */
export function withDeliveries(db: DatabaseSync, messages: Row[]): Array<{ message: Row; deliveries: Row[] }> {
	const deliveries = db.prepare(
		"SELECT recipient, delivered_at, completed_at, dead_at, relay_to FROM deliveries WHERE message = ? ORDER BY recipient",
	);
	return messages.map((message) => ({ message, deliveries: deliveries.all(num(message.id)) as Row[] }));
}

/** The messages of `team` created after `since`, newest first, each with its deliveries' state. */
export function recentTraffic(
	db: DatabaseSync,
	team: string,
	since: number,
	limit: number,
): ReturnType<typeof withDeliveries> {
	const sql = "SELECT * FROM messages WHERE team = ? AND created_at > ? ORDER BY id DESC LIMIT ?";
	return withDeliveries(db, db.prepare(sql).all(team, since, limit));
}

/**
 * The questions `child` sent `parent` since `since`, oldest first, each with the first reply from the parent or `user`
 * (`/agents tell` answers one directly). A relay row is addressed to the parent but asks the agent in `relay_to`, so it
 * is a peer ask (`unansweredAsks`), not one of these.
 */
export function asks(
	db: DatabaseSync,
	team: string,
	child: string,
	parent: string,
	user: string,
	since: number,
): Row[] {
	return db
		.prepare(
			`SELECT m.id, m.body, m.created_at, r.id AS reply_id, r.created_at AS reply_at, r.sender AS reply_by
         FROM messages m JOIN deliveries d ON d.message = m.id AND d.recipient = ? AND d.relay_to IS NULL
         LEFT JOIN messages r ON r.id = (
           SELECT min(reply.id) FROM messages reply
           JOIN deliveries receipt ON receipt.message = reply.id AND receipt.recipient = m.sender
           WHERE reply.reply_to = m.id AND reply.sender IN (d.recipient, ?))
         WHERE m.team = ? AND m.sender = ? AND m.reply_required = 1 AND m.created_at >= ? ORDER BY m.id`,
		)
		.all(parent, user, team, child, since);
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
             WHERE m.team = ? AND m.sender = ? AND m.reply_required = 1 AND d.completed_at IS NULL AND d.dead_at IS NULL
               AND COALESCE(d.relay_to, d.recipient) != ?
               AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id AND r.sender = COALESCE(d.relay_to, d.recipient))`,
				)
				.get(team, sender, except) as Row
		).n,
	);
}

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
 * Closes the questions `asker` sent `recipient` that it read and has not answered, including those dead-lettered when the
 * recipient left before its report: the report answered them, so each is a completed delivery (no dead letter, and the
 * asker is not told it went unanswered). A dead letter the asker was already told of stays one. Relay requests stay.
 */
export function closeQuestionsTo(db: DatabaseSync, asker: string, recipient: string, now: number): void {
	db.prepare(
		`UPDATE deliveries SET completed_at = COALESCE(completed_at, ?), dead_at = CASE WHEN notified_at IS NULL THEN NULL ELSE dead_at END
       WHERE recipient = ? AND relay_to IS NULL AND delivered_at IS NOT NULL AND (completed_at IS NULL OR (dead_at IS NOT NULL AND notified_at IS NULL))
       AND message IN (SELECT id FROM messages WHERE sender = ? AND reply_required = 1)`,
	).run(now, recipient, asker);
}

/**
 * The questions read and not yet answered in `team`, oldest first: recipient, message id, sender, body and time. The
 * same rows `agents.inTeam` counts as `pending`; relay requests are the parent's errand, not questions to it.
 */
export function openQuestions(db: DatabaseSync, team: string): Row[] {
	return db
		.prepare(
			`SELECT d.recipient, m.id, m.sender, m.body, m.created_at FROM deliveries d JOIN messages m ON m.id = d.message
         WHERE m.team = ? AND m.reply_required = 1 AND d.delivered_at IS NOT NULL AND d.completed_at IS NULL
           AND d.dead_at IS NULL AND d.relay_to IS NULL
         ORDER BY m.id`,
		)
		.all(team);
}

/** When `a` and `b` last exchanged a message, in either direction, relay requests aside; 0 when no such message is kept. */
export function lastExchange(db: DatabaseSync, team: string, a: string, b: string): number {
	const row = db
		.prepare(
			`SELECT MAX(m.created_at) AS at FROM messages m JOIN deliveries d ON d.message = m.id
         WHERE m.team = ? AND d.relay_to IS NULL AND ((m.sender = ? AND d.recipient = ?) OR (m.sender = ? AND d.recipient = ?))`,
		)
		.get(team, a, b, b, a) as { at: number | null } | undefined;
	return row?.at ?? 0;
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

/** Dead-letters unread deliveries (completed or not) of messages made before `before` whose recipient has no agent row: nothing will read them. */
export function deadLetterOrphans(db: DatabaseSync, before: number, now: number): void {
	db.prepare(
		`UPDATE deliveries SET dead_at = ? WHERE delivered_at IS NULL AND dead_at IS NULL
       AND recipient NOT IN (SELECT id FROM agents) AND message IN (SELECT id FROM messages WHERE created_at < ?)`,
	).run(now, before);
}

/** Dead deliveries of `sender`'s messages not yet reported to it, oldest first. */
export function deadLetters(db: DatabaseSync, team: string, sender: string, limit: number): Row[] {
	return db
		.prepare(
			`SELECT m.id, m.body, d.recipient, d.delivered_at, d.relay_to, d.note FROM deliveries d JOIN messages m ON m.id = d.message
         WHERE m.team = ? AND m.sender = ? AND d.dead_at IS NOT NULL AND d.notified_at IS NULL ORDER BY m.id, d.recipient LIMIT ?`,
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

/**
 * Up to `limit` ids of the messages up to `through` that wait undelivered for `id`, oldest first, leaving out `skip`
 * (ids the caller already tracks, so they never fill the window). Rows past `limit` stay waiting for a later call.
 */
export function waitingIds(
	db: DatabaseSync,
	id: string,
	through: number,
	skip: ReadonlySet<number>,
	limit: number,
): number[] {
	const rows = db
		.prepare(
			"SELECT message FROM deliveries WHERE recipient = ? AND message <= ? AND message NOT IN (SELECT value FROM json_each(?)) AND delivered_at IS NULL AND dead_at IS NULL AND relay_to IS NULL ORDER BY message LIMIT ?",
		)
		.all(id, through, JSON.stringify([...skip]), limit) as Row[];
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
