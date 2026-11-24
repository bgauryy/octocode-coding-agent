import {
	eventSubscriptions,
	events,
	isBusy,
	transactionWhenReady,
	withoutWaiting,
	type AgentDb,
	type Appended,
} from "../../../../../db/src/api.ts";
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
	private pending?: Promise<void>;
	private readonly agent: AgentDb;
	private readonly options: DbStoreOptions;
	private readonly subscriptionId: number;
	private readonly now: () => number;

	private constructor(agent: AgentDb, options: DbStoreOptions, subscriptionId: number) {
		this.agent = agent;
		this.subscriptionId = subscriptionId;
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	static async open(agent: AgentDb, options: DbStoreOptions): Promise<DbEventStore> {
		const now = options.now ?? Date.now;
		const subscription: Subscription = {
			subscriber: options.subscriber,
			topic: ALL_TOPICS as Subscription["topic"],
			deliver: "wake",
			durable: true,
			action: { type: "message", to: options.subscriber, text: "" },
			...(options.ttlMs === undefined ? {} : { expiresAt: now() + options.ttlMs }),
		};
		const row = await transactionWhenReady(agent, () =>
			eventSubscriptions.upsert(
				agent.db,
				toNewSubscription(options, subscription, events.lastSeq(agent.db, options.workspaceId), now()),
			),
		);
		return new DbEventStore(agent, options, fromSubscriptionRow(row).id);
	}

	/** Try the usual single statement immediately. Once a peer owns the writer, keep subsequent writes in arrival order. */
	private write<T>(work: () => T): T | Promise<T> {
		const attempt = () => {
			try {
				return withoutWaiting(this.agent.db, work);
			} catch (error) {
				if (!isBusy(error)) throw error;
				return transactionWhenReady(this.agent, work);
			}
		};
		const result = this.pending ? this.pending.then(attempt) : attempt();
		if (result instanceof Promise) {
			const clear = () => {
				if (this.pending === pending) this.pending = undefined;
			};
			const pending = result.then(clear, clear);
			this.pending = pending;
		}
		return result;
	}

	settled(): Promise<void> {
		return this.pending ?? Promise.resolve();
	}

	append(event: NewAgentEvent): Appended | Promise<Appended> {
		const row = toNewEvent(this.options.workspaceId, this.options.sessionId, event);
		return this.write(() => events.append(this.agent.db, row));
	}

	offset(): number {
		const rows = eventSubscriptions.forSubscriber(
			this.agent.db,
			this.options.workspaceId,
			this.options.subscriber,
			this.now(),
		);
		const own = rows.find((row) => row.id === this.subscriptionId);
		if (!own) throw new Error(`the loop's subscription ${this.subscriptionId} is gone`);
		return own.offset_seq;
	}

	commit(seq: number): void | Promise<void> {
		return this.write(() => {
			eventSubscriptions.advance(this.agent.db, this.subscriptionId, seq, this.now());
		});
	}

	unread(limit?: number, after = this.offset()): AgentEvent[] {
		return events
			.read(this.agent.db, {
				workspaceId: this.options.workspaceId,
				after,
				// A session replays its own events, never another session's of the workspace.
				...(this.options.sessionId === undefined ? {} : { sessionId: this.options.sessionId }),
				...(limit ? { limit } : {}),
			})
			.map(fromEventRow);
	}
}
