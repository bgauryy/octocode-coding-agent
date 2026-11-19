import type { DatabaseSync } from "node:sqlite";
import { allRows, type Row } from "../rows.ts";
import { API_MESSAGE_RECEIPTS_SCHEMA } from "../schema-sql.ts";

/**
 * What the external API knows of a keyed `message.send`, kept across a restart: `preparing` (reviewed, nothing sent
 * yet), `accepted` (handed to the session) or `uncertain` (the hand-off failed after dispatch). A send that was
 * refused or never left preparation has no row: its key is free again.
 */
export type ApiReceiptPhase = "preparing" | "accepted" | "uncertain";

export interface ApiReceiptRow {
	fingerprint: string;
	messageId: string;
	queued: string;
	phase: ApiReceiptPhase;
	updatedAt: number;
}

/** Rows older than this are dropped when a new one is written. */
const RETENTION_MS = 7 * 24 * 3_600_000;

const ensured = new WeakSet<DatabaseSync>();

/** Creates the table in a file made before it existed. Once per connection; a no-op on a current file. */
export function ensure(db: DatabaseSync): void {
	if (ensured.has(db)) return;
	db.exec(API_MESSAGE_RECEIPTS_SCHEMA);
	ensured.add(db);
}

/** Records (or replaces) the receipt of `key` in `sessionId`. */
export function save(
	db: DatabaseSync,
	sessionId: string,
	key: string,
	row: Omit<ApiReceiptRow, "updatedAt">,
	at: number,
): void {
	ensure(db);
	db.prepare("DELETE FROM api_message_receipts WHERE updated_at < ?").run(at - RETENTION_MS);
	db.prepare(
		`INSERT INTO api_message_receipts (session_id, key, fingerprint, message_id, queued, phase, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(session_id, key) DO UPDATE SET fingerprint = excluded.fingerprint, message_id = excluded.message_id,
		 queued = excluded.queued, phase = excluded.phase, updated_at = excluded.updated_at`,
	).run(sessionId, key, row.fingerprint, row.messageId, row.queued, row.phase, at);
}

/** Moves an existing receipt to `phase`; a missing row stays missing. */
export function setPhase(db: DatabaseSync, sessionId: string, key: string, phase: ApiReceiptPhase, at: number): void {
	ensure(db);
	db.prepare("UPDATE api_message_receipts SET phase = ?, updated_at = ? WHERE session_id = ? AND key = ?").run(
		phase,
		at,
		sessionId,
		key,
	);
}

export function find(db: DatabaseSync, sessionId: string, key: string): ApiReceiptRow | undefined {
	ensure(db);
	const [row] = allRows<Row>(
		db.prepare(
			"SELECT fingerprint, message_id, queued, phase, updated_at FROM api_message_receipts WHERE session_id = ? AND key = ?",
		),
		sessionId,
		key,
	);
	if (!row) return undefined;
	return {
		fingerprint: String(row.fingerprint),
		messageId: String(row.message_id),
		queued: String(row.queued),
		phase: row.phase as ApiReceiptPhase,
		updatedAt: Number(row.updated_at),
	};
}

/** Frees `key`: the message never left preparation, or was refused. */
export function forget(db: DatabaseSync, sessionId: string, key: string): void {
	ensure(db);
	db.prepare("DELETE FROM api_message_receipts WHERE session_id = ? AND key = ?").run(sessionId, key);
}

/** Empties the table (a purge of everything); returns the rows removed. */
export function clear(db: DatabaseSync): number {
	ensure(db);
	return Number(db.prepare("DELETE FROM api_message_receipts").run().changes);
}
