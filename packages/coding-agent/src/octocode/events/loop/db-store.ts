import { eventSubscriptions, events, type Db } from "../../../../../db/src/api.ts";
import type { AgentEvent, Subscription } from "../topics.ts";
import {
	fromEventRow,
	fromSubscriptionRow,
	ALL_TOPICS,
	type NewAgentEvent,
	toNewEvent,
	toNewSubscription,
} from "./rows.ts";
import type { EventStore } from "./store.ts";

export interface DbStoreOptions {
	workspaceId: string;
	sessionId?: string;
	/** The loop's subscriber name; its subscription is the delivery offset. */
	subscriber: string;
	pid?: number;
	started?: string;
	now?: () => number;
	/** How long the loop's subscription (its offset) lives without a restart renewing it, in ms; none means it never expires. */
	ttlMs?: number;
}

/**
 * The durable store: events in `event_log`, the delivery offset in the loop's own subscription to every topic. A loop
 * that starts again under the same subscriber finds its offset and reads on from it; a new subscriber starts at the end
 * of the log.
 */
export class DbEventStore implements EventStore {
	private readonly db: Db;
	private readonly options: DbStoreOptions;
	private readonly subscriptionId: number;
	private readonly now: () => number;

	constructor(db: Db, options: DbStoreOptions) {
		this.db = db;
		this.options = options;
		this.now = options.now ?? Date.now;
		const subscription: Subscription = {
			subscriber: options.subscriber,
			topic: ALL_TOPICS as Subscription["topic"],
			deliver: "wake",
			durable: true,
			action: { type: "message", to: options.subscriber, text: "" },
			...(options.ttlMs === undefined ? {} : { expiresAt: this.now() + options.ttlMs }),
		};
		const row = eventSubscriptions.upsert(
			db,
			toNewSubscription(options, subscription, events.lastSeq(db, options.workspaceId), this.now()),
		);
		this.subscriptionId = fromSubscriptionRow(row).id;
	}

	append(event: NewAgentEvent): { seq: number; inserted: boolean } {
		return events.append(this.db, toNewEvent(this.options.workspaceId, this.options.sessionId, event));
	}

	offset(): number {
		const rows = eventSubscriptions.forSubscriber(
			this.db,
			this.options.workspaceId,
			this.options.subscriber,
			this.now(),
		);
		const own = rows.find((row) => row.id === this.subscriptionId);
		if (!own) throw new Error(`the loop's subscription ${this.subscriptionId} is gone`);
		return own.offset_seq;
	}

	commit(seq: number): void {
		eventSubscriptions.advance(this.db, this.subscriptionId, seq, this.now());
	}

	unread(limit?: number): AgentEvent[] {
		return events
			.read(this.db, {
				workspaceId: this.options.workspaceId,
				after: this.offset(),
				// A session replays its own events, never another session's of the workspace.
				...(this.options.sessionId === undefined ? {} : { sessionId: this.options.sessionId }),
				...(limit ? { limit } : {}),
			})
			.map(fromEventRow);
	}
}
