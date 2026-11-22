import { eventSubscriptions, events, type Db } from "../../../../db/src/api.ts";
import { fromEventRow, fromSubscriptionRow, type NewAgentEvent, toNewEvent, toNewSubscription } from "./loop/rows.ts";
import type { AgentEvent, Subscription } from "./topics.ts";

/**
 * The one way an internal hook hears the event log (RFC agent-event-loop §6, §14 R10): it subscribes to a topic and gets each
 * event of its session once, in order, from the offset its `event_subscriptions` row keeps. A restarted session finds the
 * row and reads on from the offset, so what was published but not handled is handled once; a hook that fails is recorded
 * and the offset moves past the event, so one bad handler never holds back its own later events or another hook's.
 * This is for code that reacts (a reflex, a user-hook run, a ping); the loop's own delivery to the model stays in `loop/`.
 */

export interface HookSubscriber {
	/** A stable id for the hook; with the session it names the subscription, so it must not change between runs. */
	hook: string;
	topic: Subscription["topic"];
	/** The handler kinds it runs, kept in the row's action (`command`, `http`, `prompt`, `mcp_tool`, `internal`). */
	kinds?: readonly string[];
	/** Handles one event. May be async; the next event waits for it. A throw is recorded, not retried. */
	handle(event: AgentEvent): void | Promise<void>;
}

export interface SubscribersOptions {
	workspaceId: string;
	sessionId: string;
	pid?: number;
	/** How long a subscription (its offset) outlives its last subscribe, in ms; none means it never expires. */
	ttlMs?: number;
	now?: () => number;
	/** Records a handler's failure. Required: a failure must reach a log, never vanish. */
	failed(hook: string, event: AgentEvent, error: unknown): void;
}

interface Active {
	sub: HookSubscriber;
	id: number;
	offset: number;
}

const PAGE = 100;

export class EventSubscribers {
	private readonly db: Db;
	private readonly options: SubscribersOptions;
	private readonly now: () => number;
	private readonly active = new Set<Active>();
	private chain: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(db: Db, options: SubscribersOptions) {
		this.db = db;
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	/** Subscribes; a new subscription starts at the end of the log, an existing one at its stored offset. Returns what stops it (the offset stays). */
	subscribe(sub: HookSubscriber): () => void {
		if (this.closed) throw new Error("the subscribers are closed");
		const { workspaceId, sessionId, pid, ttlMs } = this.options;
		const row = eventSubscriptions.upsert(
			this.db,
			toNewSubscription(
				{ workspaceId, sessionId, ...(pid === undefined ? {} : { pid }) },
				{
					subscriber: `hook:${sub.hook}:${sessionId}`,
					topic: sub.topic,
					deliver: "record",
					durable: true,
					action: { type: "hook", hook: sub.hook, ...(sub.kinds ? { kinds: sub.kinds } : { kinds: ["internal"] }) },
					...(ttlMs === undefined ? {} : { expiresAt: this.now() + ttlMs }),
				},
				events.lastSeq(this.db, workspaceId),
				this.now(),
			),
		);
		const stored = fromSubscriptionRow(row);
		const entry: Active = { sub, id: stored.id, offset: stored.offset };
		this.active.add(entry);
		return () => void this.active.delete(entry);
	}

	/** Writes the event to the log and delivers it, and anything older a subscriber has not seen, before the promise settles. */
	async publish(event: NewAgentEvent): Promise<{ seq: number; inserted: boolean }> {
		const written = events.append(this.db, toNewEvent(this.options.workspaceId, this.options.sessionId, event));
		if (written.inserted) await this.pump();
		return written;
	}

	/** Delivers what the log holds past each subscriber's offset. Runs one at a time, so an event is never handled twice. */
	pump(): Promise<void> {
		const run = this.chain.then(() => this.deliver());
		this.chain = run.catch(() => undefined);
		return run;
	}

	/** Stops delivering and waits for the handler running now. */
	async close(): Promise<void> {
		this.closed = true;
		this.active.clear();
		await this.chain;
	}

	private async deliver(): Promise<void> {
		// oxlint-disable-next-line unicorn/no-useless-spread -- subscriptions added by a handler start with the next delivery pass.
		for (const entry of [...this.active]) {
			for (;;) {
				if (!this.active.has(entry)) break;
				const rows = events.read(this.db, {
					workspaceId: this.options.workspaceId,
					after: entry.offset,
					sessionId: this.options.sessionId,
					topic: entry.sub.topic,
					limit: PAGE,
				});
				for (const row of rows) {
					if (!this.active.has(entry)) break;
					const event = fromEventRow(row);
					try {
						await entry.sub.handle(event);
					} catch (error) {
						this.options.failed(entry.sub.hook, event, error);
					}
					entry.offset = event.seq;
					eventSubscriptions.advance(this.db, entry.id, event.seq, this.now());
				}
				if (rows.length < PAGE) break;
			}
		}
	}
}
