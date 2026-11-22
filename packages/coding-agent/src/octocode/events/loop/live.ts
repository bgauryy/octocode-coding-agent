import type { Source } from "../source-types.ts";
import type { AgentEvent, PayloadEvent } from "../topics.ts";
import { EventLoop } from "./loop.ts";
import { RunSignals, type SessionSignals } from "./signals.ts";
import { type EventStore, MemoryEventStore } from "./store.ts";
import type { Batch, DeliveryPoint, EventCatalog } from "./types.ts";

/**
 * The loop that delivers for real (`runtime.eventLoop: "new"`, RFC agent-event-loop §14 R6): the topics in `cutover.ts` reach
 * the session through it and not through the wake gate's own send. The loop decides when and in what batch; `send` hands
 * the batch to the session and owns each sender's receipt. It never starts a turn itself: `send` does, by asking the last
 * message of a triggering batch to.
 *
 * The loop writes what it hears to its `store` (memory by default, the event log in a session). An entry with a `body` is
 * one a restarted session sends again: `replay` queues what the store holds past its offset, each `carryOf` rebuilding
 * the sender's message from the stored body. An entry without one (a job's exit, whose row and log are the record) is
 * not replayed.
 */
export interface LiveOptions<C> {
	catalog: EventCatalog;
	/** Where events and the delivery offset live; default memory. */
	store?: EventStore;
	/** The window after a wake finds the session idle, in ms (`runtime.eventWindowSeconds`), read at each wake. */
	windowMs: () => number;
	/**
	 * Sends one batch: each entry's own message in order, only the last asking for a turn when `batch.trigger`. `ending`: the
	 * session is going away, so nothing may start a turn. Must not return the run's promise: the loop waits for it.
	 */
	send(batch: Batch<C>, point: DeliveryPoint, ending: boolean): void;
	/** A failure of the loop itself, not of a send. */
	failed(error: unknown): void;
}

/** A background event for the live loop; `carry` is the sender's own message and receipt, handed back at delivery. */
export interface LiveEntry<C> {
	event: PayloadEvent;
	source: Source;
	/** Asks for a turn: false rides along with the next one. */
	wake: boolean;
	/** Joins the run in progress at its next step boundary. */
	steer: boolean;
	carry: C;
	/** A second entry with this key is the same event: not queued or delivered again. */
	dedupeKey?: string;
	/** Stored with the event so `replay` can rebuild `carry`; JSON. */
	body?: Record<string, unknown>;
}

export class LiveLoop<C> implements SessionSignals {
	private readonly loop: EventLoop<C>;
	private readonly signals: RunSignals;
	private ending = false;

	constructor(options: LiveOptions<C>) {
		this.loop = new EventLoop<C>({
			store: options.store ?? new MemoryEventStore(),
			catalog: options.catalog,
			windowMs: options.windowMs,
			deliver: (batch, point) => options.send(batch, point, this.ending),
			onError: options.failed,
		});
		this.signals = new RunSignals(this.loop);
	}

	/** What each queue holds, for tests and status lines. */
	queued(): ReturnType<EventLoop<C>["queued"]> {
		return this.loop.queued();
	}

	/** Queues one event; a wake with the session idle opens the window, a busy or locked session delivers later. `accepted` is false for an event the log already holds: it is not delivered again. */
	take(entry: LiveEntry<C>): { accepted: boolean } {
		return this.loop.publish(entry);
	}

	/** Q1: text the user typed or a client sent, with its source: delivered ahead of every background event and never held by the window. */
	input(text: string, carry: C, source: Source): void {
		this.loop.input(text, carry, source);
	}

	/** Q0 (Stop, a permission answer): runs `act` now, whatever the state, window or lock; no queue changes. */
	preempt<T>(act: () => T): T {
		return this.loop.preempt(act);
	}

	/**
	 * Queues what a restarted session left undelivered: the stored events that carry a body, each a wake (only wakes are
	 * taken with a body). Returns how many were queued; events without a body are passed over, not delivered.
	 */
	replay(carryOf: (event: PayloadEvent, stored: AgentEvent) => C): number {
		return this.loop.replay(carryOf, { keep: (stored) => stored.body !== undefined, wakes: () => true });
	}

	runStarted(): void {
		this.loop.signal("run_start");
	}

	stepEnded(final: boolean): void {
		this.signals.stepEnded(final);
	}

	turnStarted(): void {
		this.signals.turnStarted();
	}

	settled(continues: boolean): void {
		this.signals.settled(continues);
	}

	compactionStarted(): void {
		this.loop.lock();
	}

	compactionEnded(): void {
		this.loop.unlock();
	}

	/** Delivers everything queued without starting a turn (`send` gets `ending`), and stops the timer. */
	end(): void {
		this.ending = true;
		this.loop.close();
	}
}
