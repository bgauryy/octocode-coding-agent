import type { Source } from "../source-types.ts";
import type { AgentEvent, PayloadEvent } from "../topics.ts";
import { recordsEvent } from "./cutover.ts";
import { EventLoop } from "./loop.ts";
import { RunSignals, type SessionSignals } from "./signals.ts";
import { type EventStore, MemoryEventStore } from "./store.ts";
import type { Batch, DeliveryPoint, EventCatalog, InputMode, Priority } from "./types.ts";

/** The scheduler chooses when to deliver. The host sends each message in the batch and lets its last message start a
 * turn when needed. Replay rebuilds pending messages from the stored envelope and skips events without one. */
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
	send(batch: Batch<C>, point: DeliveryPoint, mayWake: () => boolean, ending: () => boolean): void | Promise<void>;
	/** A failure of the loop itself, not of a send. */
	failed(error: unknown): void;
	/** Stops the step in progress for an urgent entry (`LoopOptions.interrupt`). */
	interrupt?: () => void;
}

/** A background event for the live loop; `carry` is the sender's own message and receipt, handed back at delivery. */
export interface LiveEntry<C> {
	event: PayloadEvent;
	source: Source;
	/** Asks for a turn: false rides along with the next one. */
	wake: boolean;
	/** How soon it is delivered (`types.ts`); the catalog's answer for the event. */
	priority: Priority;
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
	private handoff?: Promise<void>;
	private wakeGeneration = 0;

	constructor(options: LiveOptions<C>) {
		this.loop = new EventLoop<C>({
			store: options.store ?? new MemoryEventStore(),
			catalog: options.catalog,
			windowMs: options.windowMs,
			deliver: (batch, point) => {
				const owner = this.wakeGeneration;
				const sending = options.send(
					batch,
					point,
					() => owner === this.wakeGeneration && !this.ending,
					() => this.ending,
				);
				if (!sending) return;
				this.handoff = sending.finally(() => {
					this.handoff = undefined;
				});
				return this.handoff;
			},
			onError: options.failed,
			...(options.interrupt ? { interrupt: options.interrupt } : {}),
		});
		this.signals = new RunSignals(this.loop);
	}

	/** What each queue holds, for tests and status lines. */
	queued(): ReturnType<EventLoop<C>["queued"]> {
		return this.loop.queued();
	}

	/** Queues one event; a wake with the session idle opens the window, a busy or locked session delivers later. `accepted` is false for an event the log already holds: it is not delivered again. */
	take(entry: LiveEntry<C>): { accepted: boolean } | Promise<{ accepted: boolean }> {
		if (recordsEvent(entry.event)) return this.loop.publish(entry);
		this.loop.notify(entry);
		return { accepted: true };
	}

	/** Q1: text the user typed or a client sent, with its source: never held by the window. It releases the events the window held, which are written to the conversation ahead of the prompt the session then starts. */
	input(text: string, carry: C, source: Source, mode?: InputMode): void {
		this.wakeGeneration++;
		this.loop.input(text, carry, source, mode);
	}

	/** An admitted custom message is starting its own run. Include idle completions before its first request. */
	async joinStartingRun(): Promise<void> {
		this.wakeGeneration++;
		if (this.handoff) await this.joinHandoffs();
		this.loop.flushNow(true);
		if (this.handoff) await this.joinHandoffs();
	}

	/** Q0 (Stop, a permission answer): runs `act` now, whatever the state, window or lock; no queue changes. */
	preempt<T>(act: () => T): T {
		return this.loop.preempt(act);
	}

	/**
	 * Queues what a restarted session left undelivered: the stored events that carry a body, each a wake (only wakes are
	 * taken with a body). Returns how many were queued; events without a body are passed over, not delivered.
	 */
	replay(
		carryOf: (event: PayloadEvent, stored: AgentEvent) => C,
		keep?: (stored: AgentEvent) => boolean,
	): Promise<number> {
		return this.loop.replay(carryOf, {
			keep: (stored) => stored.body !== undefined && (keep?.(stored) ?? true),
			wakes: () => true,
		});
	}

	runStarted(): void {
		this.loop.signal("run_start");
	}

	stepEnded(final: boolean): void | Promise<void> {
		this.signals.stepEnded(final);
		return this.handoff;
	}

	turnStarted(): void {
		this.signals.turnStarted();
	}

	settled(continues: boolean, aborted = false): void {
		// A run the loop stopped itself (an urgent entry) settles like any other: what stopped it starts the next turn.
		// A run someone else stopped (the user's Stop, a guard) is not answered with a new one.
		const interrupted = this.loop.takeInterrupt();
		if (aborted && !interrupted) {
			const owner = ++this.wakeGeneration;
			const stop = () => {
				if (this.ending || owner !== this.wakeGeneration) return;
				this.loop.handOver();
			};
			// EventLoop takes the handoff before this callback, so a stop also drains arrivals during that handoff.
			if (this.handoff) void this.handoff.then(stop, () => undefined);
			else stop();
			return;
		}
		this.signals.settled(continues);
	}

	compactionStarted(): void {
		this.loop.lock();
	}

	compactionEnded(stopped = false): void | Promise<void> {
		if (!stopped) {
			this.loop.unlock();
			// The host resumes from the summary once every released message has reached its input queue.
			if (this.handoff) return this.joinHandoffs();
			return;
		}
		// A compaction the user stopped is not answered with a turn: what waited behind the lock is handed over quietly,
		// and so is what arrives while that hand-over is still being written.
		const owner = ++this.wakeGeneration;
		this.loop.unlock(true);
		if (this.handoff) return this.handOverQuietly(owner);
	}

	/** Waits out each hand-over in progress and gives what arrived meanwhile to the same stop, until nothing is in flight. */
	private async handOverQuietly(owner: number): Promise<void> {
		while (this.handoff) {
			await Promise.allSettled([this.handoff]);
			if (this.ending || owner !== this.wakeGeneration) return;
			this.loop.flushNow(true);
		}
	}

	/** Completion of the current transcript delivery. The model run has its own lifetime. */
	pendingHandoff(): Promise<void> | undefined {
		return this.handoff;
	}

	/** Delivers everything queued without starting a turn (`send` gets `ending`), and stops the timer. */
	end(): void | Promise<void> {
		this.ending = true;
		this.loop.close();
		if (this.handoff) return this.joinHandoffs();
	}

	/** Wait through the final queued batch too. EventLoop owns delivery failures. */
	private async joinHandoffs(): Promise<void> {
		while (this.handoff) await Promise.allSettled([this.handoff]);
	}

	/** A replacement owns the host now. Leave any remaining entries in this session's log. */
	discard(): void {
		this.ending = true;
		this.loop.dispose();
	}
}
