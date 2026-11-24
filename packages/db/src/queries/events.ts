import type { DatabaseSync } from "node:sqlite";
import { allRows } from "../rows.ts";
import { keptStatement } from "../statements.ts";

/**
 * The durable event log (`event_log`, `schema-events.ts`): an append-only, ordered record that consumers read from an
 * offset, so a restarted process replays what it missed. `source`, `payload` and `ref` are the JSON text of the caller's
 * `Source`, topic payload and `Handle`; the log never reads inside them. The topic of a row is one of the runtime's
 * catalog; the database does not know the catalog.
 */

/** An event as stored: the caller's fields as text plus the order the log gave it. */
export interface EventRow {
	seq: number;
	workspace_id: string;
	session_id: string | null;
	at: number;
	topic: string;
	key: string;
	source: string;
	payload: string;
	digest: string;
	ref: string | null;
	dedupe_key: string | null;
}

/** The fields of an event to append. */
export interface NewEvent {
	workspaceId: string;
	sessionId?: string;
	at: number;
	topic: string;
	key: string;
	/** JSON text of the `Source`. */
	source: string;
	/** JSON text of the payload. */
	payload: string;
	/** The one line the model may see. */
	digest: string;
	/** JSON text of the `Handle` where the full object lives. */
	ref?: string;
	/** An event with a dedupe key already in this workspace's log is not appended again. */
	dedupeKey?: string;
}

export interface Appended {
	seq: number;
	/** False when the dedupe key was already in the log; `seq` is then the earlier event's. */
	inserted: boolean;
}

/** Appends one event, or finds the earlier one with the same dedupe key. */
export function append(db: DatabaseSync, event: NewEvent): Appended {
	const result = keptStatement(
		db,
		`INSERT INTO event_log (workspace_id, session_id, at, topic, key, source, payload, digest, ref, dedupe_key)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, dedupe_key) DO NOTHING`,
	).run(
		event.workspaceId,
		event.sessionId ?? null,
		event.at,
		event.topic,
		event.key,
		event.source,
		event.payload,
		event.digest,
		event.ref ?? null,
		event.dedupeKey ?? null,
	);
	if (Number(result.changes) > 0) return { seq: Number(result.lastInsertRowid), inserted: true };
	const earlier = keptStatement(db, "SELECT seq FROM event_log WHERE workspace_id = ? AND dedupe_key = ?").get(
		event.workspaceId,
		event.dedupeKey ?? null,
	) as { seq: number } | undefined;
	if (!earlier) throw new Error("event_log insert was ignored without a matching dedupe key");
	return { seq: earlier.seq, inserted: false };
}

export interface ReadOptions {
	workspaceId: string;
	/** Only events after this `seq` (a subscription's `offset_seq`). */
	after: number;
	/** An exact topic, or a prefix pattern `job.*`. */
	topic?: string;
	/** Only events a session wrote: a loop replays its own, never another session's of the workspace. */
	sessionId?: string;
	limit?: number;
}

const DEFAULT_LIMIT = 200;

/** Events of the workspace after `after`, oldest first, optionally of one topic or topic family. */
export function read(db: DatabaseSync, options: ReadOptions): EventRow[] {
	const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 1000));
	const { topic, sessionId } = options;
	if (sessionId !== undefined) {
		if (topic) {
			const family = topic.endsWith(".*");
			return allRows<EventRow>(
				keptStatement(
					db,
					family
						? "SELECT * FROM event_log WHERE workspace_id = ? AND seq > ? AND session_id = ? AND substr(topic, 1, ?) = ? ORDER BY seq LIMIT ?"
						: "SELECT * FROM event_log WHERE workspace_id = ? AND seq > ? AND session_id = ? AND topic = ? ORDER BY seq LIMIT ?",
				),
				options.workspaceId,
				options.after,
				sessionId,
				...(family ? [topic.length - 1, topic.slice(0, -1)] : [topic]),
				limit,
			);
		}
		return allRows<EventRow>(
			keptStatement(
				db,
				"SELECT * FROM event_log WHERE workspace_id = ? AND seq > ? AND session_id = ? ORDER BY seq LIMIT ?",
			),
			options.workspaceId,
			options.after,
			sessionId,
			limit,
		);
	}
	if (topic?.endsWith(".*")) {
		const prefix = topic.slice(0, -1);
		return allRows<EventRow>(
			keptStatement(
				db,
				"SELECT * FROM event_log WHERE workspace_id = ? AND seq > ? AND substr(topic, 1, ?) = ? ORDER BY seq LIMIT ?",
			),
			options.workspaceId,
			options.after,
			prefix.length,
			prefix,
			limit,
		);
	}
	if (topic)
		return allRows<EventRow>(
			keptStatement(
				db,
				"SELECT * FROM event_log WHERE workspace_id = ? AND seq > ? AND topic = ? ORDER BY seq LIMIT ?",
			),
			options.workspaceId,
			options.after,
			topic,
			limit,
		);
	return allRows<EventRow>(
		keptStatement(db, "SELECT * FROM event_log WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?"),
		options.workspaceId,
		options.after,
		limit,
	);
}

/** The newest `seq` of the workspace, or 0 when its log is empty: where a new subscriber starts. */
export function lastSeq(db: DatabaseSync, workspaceId: string): number {
	const row = keptStatement(db, "SELECT MAX(seq) AS seq FROM event_log WHERE workspace_id = ?").get(workspaceId) as {
		seq: number | null;
	};
	return row.seq ?? 0;
}

/** The oldest `seq` still in the workspace's log, or undefined when empty: a consumer whose offset is below it missed events. */
export function oldestSeq(db: DatabaseSync, workspaceId: string): number | undefined {
	const row = keptStatement(db, "SELECT MIN(seq) AS seq FROM event_log WHERE workspace_id = ?").get(workspaceId) as {
		seq: number | null;
	};
	return row.seq ?? undefined;
}

/** Retention: deletes up to `limit` events older than `cutoff` (ms since the epoch), oldest first; returns how many went. */
export function purgeBefore(db: DatabaseSync, cutoff: number, limit: number): number {
	return Number(
		db
			.prepare("DELETE FROM event_log WHERE seq IN (SELECT seq FROM event_log WHERE at < ? ORDER BY seq LIMIT ?)")
			.run(cutoff, limit).changes,
	);
}
