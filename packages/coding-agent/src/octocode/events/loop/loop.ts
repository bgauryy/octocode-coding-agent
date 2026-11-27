import { setImmediate as yieldToIO } from "node:timers/promises";
import type { Source } from "../source-types.ts";
import { userSource } from "../source.ts";
import type { AgentEvent, PayloadEvent } from "../topics.ts";
import { LoopQueues } from "./queues.ts";
import { buildBatch } from "./batch.ts";
import { publication } from "./rows.ts";
import { isBusy, isLocked, type LoopInput, type LoopState, nextState } from "./state.ts";
import type { Appended } from "../../../../../db/src/api.ts";
import type { LoopOptions } from "./options.ts";
import type { DeliveryPoint, EventEntry, InputEntry, InputMode, Logged, QueueId } from "./types.ts";

export type { LoopOptions } from "./options.ts";

/**
 * Schedules a single session's deliveries. Regular events join the next step of a run or the idle coalescing window.
 * Urgent entries interrupt a running step. User input bypasses the window, and compaction holds all deliveries until
 * unlock. Durable events enter their queue after append; the cursor advances only past events no queue still holds.
 */

const isPromise = (value: unknown): value is Promise<void> =>
	typeof (value as { then?: unknown } | undefined)?.then === "function";

export class EventLoop<C = undefined> {
	private readonly options: LoopOptions<C>;
	private readonly queues = new LoopQueues<C>();
	private current: LoopState = "idle";
	private lastSeq = 0;
	private committed = 0;
	private timer: NodeJS.Timeout | undefined;
	private inflight?: Array<Logged<C>>;
	private nextTick?: NodeJS.Immediate;
	private closing = false;
	private replayEnd = Infinity;
	private replaying = false;
	private disposed = false;
	/** A run is in progress, whatever the state says: a compaction inside a run hands the run back when it unlocks. */
	private runActive = false;
	/** The loop stopped the step in progress for an urgent entry, and the run has not settled since. */
	private interrupted = false;

	constructor(options: LoopOptions<C>) {
		this.options = options;
	}

	get state(): LoopState {
		return this.current;
	}

	/** What each queue holds, for tests and status lines. */
	queued(): Record<QueueId, number> {
		return this.queues.counts();
	}

	/** Q0: runs `act` now, whatever the state, window or lock. It leaves every queue as it is: nothing is dropped. */
	preempt<T>(act: () => T): T {
		return act();
	}

	/** Queues a background event once its append succeeds. A duplicate or a closed session leaves it in the log. */
	publish(entry: Omit<EventEntry<C>, "type">) {
		const written = this.options.store.append(publication(entry, this.options.catalog, this.now()));
		const queue = ({ seq, inserted }: Appended) => {
			if (!inserted || this.disposed) return { seq, accepted: false };
			if (this.replaying) this.replayEnd = Math.min(this.replayEnd, seq);
			this.lastSeq = Math.max(this.lastSeq, seq);
			this.arrived({ ...entry, type: "event" }, seq);
			return { seq, accepted: true };
		};
		return written instanceof Promise ? written.then(queue) : queue(written);
	}

	/** Session-only wakes whose producer owns its own log (such as the monitor ledger). */
	notify(entry: Omit<EventEntry<C>, "type">): void {
		this.arrived({ ...entry, type: "event" }, 0);
	}

	/** Queues an event that just arrived: a run in progress takes it at its next boundary, and an urgent one stops the step first. */
	private arrived(entry: EventEntry<C>, seq: number): void {
		const busy = isBusy(this.current);
		this.queues.enqueue(entry, seq, busy ? "Q2" : "Q3");
		if (entry.priority === "urgent" && busy && !isLocked(this.current)) {
			if (this.options.interrupt && !this.interrupted) {
				this.interrupted = true;
				try {
					this.preempt(this.options.interrupt);
				} catch {
					// The run cannot be stopped: the entry is first in line at the next step boundary.
					this.interrupted = false;
				}
			}
			return;
		}
		this.pump();
	}

	/** Q1: text the user typed or sent. It is not logged (privacy, size); locked, it waits for the drain. */
	input(text: string, carry: C, source: Source = userSource("terminal"), mode: InputMode = "queue"): void {
		this.queues.enqueue({ type: "input", text, mode, carry, source } satisfies InputEntry<C>, 0, "Q1");
		this.pump();
	}

	/**
	 * Queues the events the store holds past its offset, as a restarted session finds them. Whether one wakes is the catalog's
	 * answer unless `wakes` says otherwise; `carryOf` rebuilds what the sender would have attached from the stored event (its
	 * `body`). `keep` leaves events out of the replay (those no sender can rebuild); they are skipped, not redelivered, and the
	 * offset moves past them. Events already queued are skipped.
	 */
	async replay(
		carryOf: (event: PayloadEvent, stored: AgentEvent) => C,
		options: { keep?: (stored: AgentEvent) => boolean; wakes?: (stored: AgentEvent) => boolean } = {},
	): Promise<number> {
		if (this.replaying) throw new Error("Event replay is already running");
		const held = this.queues.sequences();
		for (const entry of this.inflight ?? []) held.add(entry.seq);
		let taken = 0;
		let cursor: number;
		const page = 200;
		this.replaying = true;
		this.replayEnd = Infinity;
		try {
			if (this.options.store.settled) await this.options.store.settled();
			if (this.disposed) return 0;
			cursor = this.options.store.offset();
			this.committed = cursor;
			while (!this.disposed) {
				const rows = this.options.store.unread(page, cursor);
				for (const stored of rows) {
					if (stored.seq >= this.replayEnd) break;
					cursor = stored.seq;
					this.lastSeq = Math.max(this.lastSeq, cursor);
					if (held.has(cursor) || (options.keep && !options.keep(stored))) continue;
					const event = { kind: stored.topic, ...stored.payload } as PayloadEvent;
					this.queues.enqueue(
						{
							type: "event",
							event,
							source: stored.source,
							wake: options.wakes ? options.wakes(stored) : this.options.catalog.wakes(stored.topic),
							// What a restart finds is late already: it is never a reason to stop the run that reads it.
							priority: "regular",
							carry: carryOf(event, stored),
						},
						cursor,
						"Q3",
						cursor - Number.MAX_SAFE_INTEGER,
					);
					taken++;
				}
				if (rows.length < page || rows[rows.length - 1].seq >= this.replayEnd) break;
				await yieldToIO();
			}
		} finally {
			this.replaying = false;
		}
		if (!this.inflight && !this.disposed) await this.commit();
		this.pump();
		return taken;
	}

	/** A state input from the host: a run started or ended, the context neared its limit, a lock was taken. */
	signal(input: LoopInput): LoopState {
		if (input === "run_start") {
			this.runActive = true;
			this.interrupted = false;
		} else if (input === "run_end") this.runActive = false;
		this.current = nextState(this.current, input);
		// A compaction that ran inside a run gives the run back: its next boundary delivers, and an urgent entry can stop it.
		if (input === "drained" && this.runActive && this.current === "idle") this.current = "running";
		if (input === "run_start" || input === "lock") this.closeWindow();
		// What the window held is the run's next task now: it joins at the first step boundary, not when the run ends.
		if (input === "run_start" && this.current === "running") this.queues.startRun();
		return this.current;
	}

	/** Between two steps of a run: typed input and every queued event join it, the urgent ones first. */
	stepBoundary(): void {
		if (
			this.disposed ||
			this.interrupted ||
			this.replaying ||
			(this.current !== "running" && this.current !== "nudged") ||
			this.inflight
		)
			return;
		const taken = this.queues.takeBatch(true);
		if (taken.length > 0) this.dispatch(taken, "boundary");
	}

	/**
	 * The run is about to continue on its own (the session holds a message it will take next): when something queued asks for
	 * a turn, everything queued goes out as one batch with it. Returns whether a batch went out.
	 */
	continueRun(): boolean {
		if (
			this.disposed ||
			this.replaying ||
			isLocked(this.current) ||
			this.current === "draining" ||
			this.current === "stopping" ||
			this.interrupted ||
			this.inflight ||
			!this.queues.hasWake
		)
			return false;
		this.dispatch(this.queues.takeBatch(), "settle");
		return true;
	}

	/**
	 * The run would stop. When something asks for a turn, everything queued goes out as one batch and the run continues
	 * (returns true); otherwise the run ends. A requested hard stop waits for the compaction lock and delivers nothing.
	 */
	settle(): boolean {
		if (this.current === "stopping" || this.inflight) return false;
		if (this.continueRun()) return true;
		this.signal("run_end");
		return false;
	}

	/** Whether the loop itself stopped the run that is settling (an urgent entry); asking clears it. */
	takeInterrupt(): boolean {
		const was = this.interrupted;
		this.interrupted = false;
		return was;
	}

	/**
	 * The run was stopped by someone else (the user's Stop, a guard): everything queued is handed over now as one batch.
	 * The host starts no turn for it: a stop is not answered with a new run. The run then ends.
	 */
	handOver(): void {
		if (this.disposed || this.replaying || this.inflight || isLocked(this.current)) return;
		const held = this.queues.takeBatch();
		if (held.length > 0) this.dispatch(held, "settle", true);
		this.signal("run_end");
	}

	/** Compaction starts: everything queues, nothing is delivered. */
	lock(): void {
		this.signal("lock");
	}

	/** Compaction ended or failed: everything held goes out once, user input first, then idle. `stopped` (cancelled): no turn. */
	unlock(stopped = false): void {
		if (!isLocked(this.current)) return;
		this.signal("unlock");
		if (!this.inflight && !this.replaying) this.drain(stopped);
	}

	private drain(stopped = false): void {
		const held = this.queues.takeBatch();
		if (held.length > 0) this.dispatch(held, "drain", stopped);
		else this.signal("drained");
	}

	/** Ends the window now: an idle session with something that asks for a turn is handed the batch (`stopped`: no turn). */
	flushNow(stopped = false): void {
		if (this.disposed || this.replaying || this.inflight || isLocked(this.current) || isBusy(this.current)) return;
		this.closeWindow();
		if (this.queues.hasWake) this.dispatch(this.queues.takeBatch(), "idle", stopped);
	}

	/** Session end: no timer outlives it and nothing more is delivered; what is queued stays in the log for the next start. */
	dispose(): void {
		this.disposed = true;
		clearImmediate(this.nextTick);
		this.closeWindow();
	}

	/**
	 * Session end for a loop that delivers for real: everything queued goes out as one last batch, in whatever state the loop is
	 * in, so each sender's receipt settles and each report is recorded; the host starts no turn for it. Then the loop is disposed.
	 */
	close(): void {
		if (this.disposed) return;
		this.closing = true;
		this.dispose();
		if (!this.inflight) this.drain();
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	/** Decides, after anything changed, whether an idle session is handed a batch now, later (window) or not. */
	private pump(): void {
		if (this.disposed || this.replaying || this.inflight || isLocked(this.current) || isBusy(this.current)) return;
		if (this.current === "draining") {
			this.drain();
			return;
		}
		if (this.queues.immediate) {
			this.closeWindow();
			this.dispatch(this.queues.takeBatch(), "idle");
			return;
		}
		if (!this.queues.hasWake) return;
		const ms = this.options.windowMs?.() ?? 0;
		if (ms <= 0) {
			this.closeWindow();
			this.dispatch(this.queues.takeBatch(), "idle");
		} else if (!this.timer) {
			this.timer = setTimeout(() => this.windowEnded(), ms);
			this.timer.unref?.();
		}
	}

	private windowEnded(): void {
		this.timer = undefined;
		if (this.disposed || this.replaying || this.inflight || isLocked(this.current) || isBusy(this.current)) return;
		if (this.queues.hasWake) this.dispatch(this.queues.takeBatch(), "idle");
	}

	private closeWindow(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	/** Hands one batch over; the offset moves when it was taken, the entries return to their queues when not. `stopped` asks for no turn. */
	private dispatch(entries: Array<Logged<C>>, point: DeliveryPoint, stopped = false): void {
		this.inflight = entries;
		try {
			const batch = buildBatch(this.options.catalog, entries);
			const sending = this.options.deliver(stopped ? { ...batch, trigger: false } : batch, point);
			if (isPromise(sending)) {
				void sending.then(
					() => this.delivered(),
					(error: unknown) => this.failed(entries, error),
				);
				return;
			}
		} catch (error) {
			this.failed(entries, error);
			return;
		}
		this.delivered();
	}

	private delivered(): void {
		this.inflight = undefined;
		try {
			if (!this.replaying) this.commit()?.catch(this.options.onError);
		} catch (error) {
			this.options.onError(error);
			return;
		}
		if (this.closing) {
			this.closing = false;
			this.drain();
			return;
		}
		if (this.current === "draining" && this.queues.empty) this.signal("drained");
		if (!this.disposed && !this.nextTick && (this.queues.hasWake || this.current === "draining")) {
			this.nextTick = setImmediate(() => {
				this.nextTick = undefined;
				this.pump();
			});
		}
	}

	private failed(entries: Array<Logged<C>>, error: unknown): void {
		this.inflight = undefined;
		this.queues.restore(entries);
		if (this.current === "draining") this.signal("drained");
		this.options.onError(error);
	}

	/** The offset: just before the oldest event a queue still holds, else the newest the loop has seen. */
	private commit(): void | Promise<void> {
		const offset = this.queues.safeOffset(this.lastSeq);
		if (offset > this.committed) {
			const saving = this.options.store.commit(offset);
			this.committed = offset;
			return saving?.catch((error: unknown) => {
				if (this.committed === offset) this.committed = 0;
				throw error;
			});
		}
	}
}
