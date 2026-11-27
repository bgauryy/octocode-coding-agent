import type { DatabaseSync } from "node:sqlite";
import { allRows } from "../rows.ts";
import { keptStatement } from "../statements.ts";

/**
 * Subscriptions to the event log (`event_subscriptions`, `schema-events.ts`): who reads which topics from which offset.
 * A subscription is identified by workspace, subscriber, topic and filter, so subscribing again updates it and keeps its
 * offset. `filter` and `action` are the JSON text of the caller's `TopicFilter` and action.
 */

export type Deliver = "wake" | "piggyback" | "record";

export interface SubscriptionRow {
	id: number;
	workspace_id: string;
	session_id: string | null;
	subscriber: string;
	/** An exact topic or a prefix pattern `job.*`. */
	topic: string;
	/** JSON text of the filter; empty for none. */
	filter: string;
	deliver: Deliver;
	durable: number;
	action: string;
	once: number;
	cost_max_per_hour: number | null;
	/** The `seq` of the last event this subscription consumed. */
	offset_seq: number;
	owner_pid: number | null;
	owner_started: string | null;
	expires_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface NewSubscription {
	workspaceId: string;
	sessionId?: string;
	subscriber: string;
	topic: string;
	filter?: string;
	deliver: Deliver;
	durable: boolean;
	action: string;
	once?: boolean;
	costMaxPerHour?: number;
	/** Where a new subscription starts reading (`events.lastSeq`); ignored when the subscription already exists. */
	startAt: number;
	ownerPid?: number;
	ownerStarted?: string;
	expiresAt?: number;
	at: number;
}

/** Creates the subscription, or updates its delivery, action, owner and expiry; its offset stays. Returns its row. */
export function upsert(db: DatabaseSync, sub: NewSubscription): SubscriptionRow {
	keptStatement(
		db,
		`INSERT INTO event_subscriptions (workspace_id, session_id, subscriber, topic, filter, deliver, durable, action, once,
		   cost_max_per_hour, offset_seq, owner_pid, owner_started, expires_at, created_at, updated_at)
		 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
		 ON CONFLICT(workspace_id, subscriber, topic, filter) DO UPDATE SET session_id = excluded.session_id,
		   deliver = excluded.deliver, durable = excluded.durable, action = excluded.action, once = excluded.once,
		   cost_max_per_hour = excluded.cost_max_per_hour, owner_pid = excluded.owner_pid,
		   owner_started = excluded.owner_started, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
	).run(
		sub.workspaceId,
		sub.sessionId ?? null,
		sub.subscriber,
		sub.topic,
		sub.filter ?? "",
		sub.deliver,
		sub.durable ? 1 : 0,
		sub.action,
		sub.once ? 1 : 0,
		sub.costMaxPerHour ?? null,
		sub.startAt,
		sub.ownerPid ?? null,
		sub.ownerStarted ?? null,
		sub.expiresAt ?? null,
		sub.at,
	);
	return keptStatement(
		db,
		"SELECT * FROM event_subscriptions WHERE workspace_id = ? AND subscriber = ? AND topic = ? AND filter = ?",
	).get(sub.workspaceId, sub.subscriber, sub.topic, sub.filter ?? "") as unknown as SubscriptionRow;
}

/** The subscriptions of one subscriber in a workspace, oldest first, skipping those that expired at `now`. */
export function forSubscriber(
	db: DatabaseSync,
	workspaceId: string,
	subscriber: string,
	now: number,
): SubscriptionRow[] {
	return allRows<SubscriptionRow>(
		keptStatement(
			db,
			`SELECT * FROM event_subscriptions WHERE workspace_id = ? AND subscriber = ?
			 AND (expires_at IS NULL OR expires_at > ?) ORDER BY id`,
		),
		workspaceId,
		subscriber,
		now,
	);
}

/** Moves a subscription's offset forward to `seq`; never back. Returns whether it moved. */
export function advance(db: DatabaseSync, id: number, seq: number, now: number): boolean {
	return (
		Number(
			keptStatement(
				db,
				"UPDATE event_subscriptions SET offset_seq = ?, updated_at = ? WHERE id = ? AND offset_seq < ?",
			).run(seq, now, id, seq).changes,
		) > 0
	);
}

/** Ends a subscription (a `once` one after delivery, or an unsubscribe). Returns whether it existed. */
export function remove(db: DatabaseSync, id: number): boolean {
	return Number(keptStatement(db, "DELETE FROM event_subscriptions WHERE id = ?").run(id).changes) > 0;
}

/** Ends the non-durable subscriptions a process owned, when it is gone; durable ones stay for the next owner. */
export function removeOwnedBy(db: DatabaseSync, ownerPid: number, ownerStarted: string | null): number {
	return Number(
		db
			.prepare(
				"DELETE FROM event_subscriptions WHERE durable = 0 AND owner_pid = ? AND COALESCE(owner_started, '') = COALESCE(?, '')",
			)
			.run(ownerPid, ownerStarted).changes,
	);
}

/** Retention: deletes the subscriptions that expired before `cutoff`, and non-durable ones untouched since; returns how many went. */
export function purgeBefore(db: DatabaseSync, cutoff: number): number {
	return Number(
		db.prepare("DELETE FROM event_subscriptions WHERE expires_at < ?1 OR (durable = 0 AND updated_at < ?1)").run(cutoff)
			.changes,
	);
}
