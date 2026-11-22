import type { Source } from "../source-types.ts";
import { userSource } from "../source.ts";
import type { AgentEvent, PayloadEvent } from "../topics.ts";
import { buildBatch } from "./batch.ts";
import type { NewAgentEvent } from "./rows.ts";
import { isBusy, isLocked, type LoopInput, type LoopState, nextState } from "./state.ts";
import type { EventStore } from "./store.ts";
import type { Batch, DeliveryPoint, Entry, EventCatalog, EventEntry, InputEntry, Logged, QueueId } from "./types.ts";

/**
 * The dispatcher of one session (RFC agent-event-loop §5.1, §6). It owns when what reaches the turn executor and nothing
 * else: it never starts a turn itself, it hands a `Batch` to `deliver` and the host starts the run.
 *
 * - Q0 (`preempt`) acts at once and is never queued, held or locked out.
 * - Q1 (`input`) is typed input: delivered at once to an idle session, at the next step boundary of a running one; the
 *   window never holds it.
 * - Q2 is a steer event for a run in progress: delivered at the next step boundary.
 * - Q3 is every other event: when the session is idle a wake opens the window and everything that arrived by its end is
 *   one batch; during a run it is delivered when the run would stop (`settle`).
 * - Compaction (`lock`) queues all of it; `unlock` delivers everything once, user input first.
 *
 * Every event is appended to the store first, so a restarted loop replays what was not delivered, once. The offset moves
 * only past events no queue still holds.
 */

export interface LoopOptions<C> {
	store: EventStore;
	/** Digests, coalescing keys and which topics wake. */
	catalog: EventCatalog;
	/** Hands over one batch. A rejection (or throw) puts its entries back in their queues and reaches `onError`. */
	deliver(batch: Batch<C>, point: DeliveryPoint): void | Promise<void>;
	/** A delivery failed in a timer or after an awaited send: nobody else can see it. */
	onError(error: unknown): void;
	/** The window after a wake that finds the session idle, in ms; read at each wake. 0 delivers at once. */
	windowMs?: () => number;
	now?: () => number;
}

const isPromise = (value: unknown): value is Promise<void> =>
	typeof (value as { then?: unknown } | undefined)?.then === "function";

export class EventLoop<C = undefined> {
	private readonly options: LoopOptions<C>;
	private readonly queues: Record<QueueId, Array<Logged<C>>> = { Q1: [], Q2: [], Q3: [] };
	private current: LoopState = "idle";
	private arrivals = 0;
	private lastSeq = 0;
	private timer: NodeJS.Timeout | undefined;
	private inflight = false;
	private disposed = false;

	constructor(options: LoopOptions<C>) {
		this.options = options;
	}

	get state(): LoopState {
		return this.current;
	}

	/** What each queue holds, for tests and status lines. */
	queued(): Record<QueueId, number> {
		return { Q1: this.queues.Q1.length, Q2: this.queues.Q2.length, Q3: this.queues.Q3.length };
	}

	/** Q0: runs `act` now, whatever the state, window or lock. It leaves every queue as it is: nothing is dropped. */
	preempt<T>(act: () => T): T {
		return act();
	}

	/**
	 * Appends a background event to the log and queues it. An event whose dedupe key the log already holds is not queued.
	 * Returns its place in the order and whether it was taken.
	 */
	publish(entry: Omit<EventEntry<C>, "type">): { seq: number; accepted: boolean } {
		const { label, key } = this.options.catalog.describe(entry.event);
		const { kind, ...payload } = entry.event;
		const written: NewAgentEvent = {
			topic: kind,
			key,
			at: this.now(),
			source: entry.source,
			payload: payload,
			digest: label,
			...(entry.dedupeKey === undefined ? {} : { dedupeKey: entry.dedupeKey }),
			...(entry.body === undefined ? {} : { body: entry.body }),
		};
		const { seq, inserted } = this.options.store.append(written);
		if (!inserted) return { seq, accepted: false };
		this.lastSeq = Math.max(this.lastSeq, seq);
		this.enqueue({ ...entry, type: "event" }, seq, entry.steer && isBusy(this.current) ? "Q2" : "Q3");
		this.pump();
		return { seq, accepted: true };
	}

	/** Q1: text the user typed or sent. It is not logged (privacy, size); locked, it waits for the drain. */
	input(text: string, carry: C, source: Source = userSource("terminal")): void {
		this.enqueue({ type: "input", text, carry, source } satisfies InputEntry<C>, 0, "Q1");
		this.pump();
	}

	/**
	 * Queues the events the store holds past its offset, as a restarted session finds them. Whether one wakes is the catalog's
	 * answer unless `wakes` says otherwise; `carryOf` rebuilds what the sender would have attached from the stored event (its
	 * `body`). `keep` leaves events out of the replay (those no sender can rebuild); they are skipped, not redelivered, and the
	 * offset moves past them. Events already queued are skipped.
	 */
	replay(
		carryOf: (event: PayloadEvent, stored: AgentEvent) => C,
		options: { keep?: (stored: AgentEvent) => boolean; wakes?: (stored: AgentEvent) => boolean } = {},
	): number {
		const held = new Set(Object.values(this.queues).flatMap((queue) => queue.map((each) => each.seq)));
		let taken = 0;
		for (const stored of this.options.store.unread()) {
			if (held.has(stored.seq)) continue;
			this.lastSeq = Math.max(this.lastSeq, stored.seq);
			if (options.keep && !options.keep(stored)) continue;
			const event = { kind: stored.topic, ...stored.payload } as PayloadEvent;
			this.enqueue(
				{
					type: "event",
					event,
					source: stored.source,
					wake: options.wakes ? options.wakes(stored) : this.options.catalog.wakes(stored.topic),
					steer: false,
					carry: carryOf(event, stored),
				},
				stored.seq,
				"Q3",
			);
			taken++;
		}
		if (taken > 0) this.pump();
		return taken;
	}

	/** A state input from the host: a run started or ended, the context neared its limit, a lock was taken. */
	signal(input: LoopInput): LoopState {
		this.current = nextState(this.current, input);
		if (input === "run_start" || input === "lock") this.closeWindow();
		return this.current;
	}

	/** Between two steps of a run: steers and typed input join it. */
	stepBoundary(): void {
		if (!isBusy(this.current) || this.inflight) return;
		const taken = [...this.take("Q1"), ...this.take("Q2")];
		if (taken.length > 0) this.dispatch(taken, "boundary");
	}

	/**
	 * The run is about to continue on its own (the session holds a message it will take next): when something queued asks for
	 * a turn, everything queued goes out as one batch with it. Returns whether a batch went out.
	 */
	continueRun(): boolean {
		if (this.current === "stopping" || this.inflight || !this.triggers()) return false;
		this.dispatch(this.takeAll(), "settle");
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

	/** Compaction starts: everything queues, nothing is delivered. */
	lock(): void {
		this.signal("lock");
	}

	/** Compaction ended or failed: everything held goes out once, user input first, then the loop is idle again. */
	unlock(): void {
		if (!isLocked(this.current)) return;
		this.signal("unlock");
		const held = this.takeAll();
		if (held.length > 0) this.dispatch(held, "drain");
		else this.signal("drained");
	}

	/** Ends the window now, as if its time had passed: an idle session with something that asks for a turn is handed the batch. */
	flushNow(): void {
		if (this.disposed || this.inflight || isLocked(this.current) || isBusy(this.current)) return;
		this.closeWindow();
		if (this.triggers()) this.dispatch(this.takeAll(), "idle");
	}

	/** Session end: no timer outlives it and nothing more is delivered; what is queued stays in the log for the next start. */
	dispose(): void {
		this.disposed = true;
		this.closeWindow();
	}

	/**
	 * Session end for a loop that delivers for real: everything queued goes out as one last batch, in whatever state the loop is
	 * in, so each sender's receipt settles and each report is recorded; the host starts no turn for it. Then the loop is disposed.
	 */
	close(): void {
		this.closeWindow();
		const held = this.inflight || this.disposed ? [] : this.takeAll();
		this.disposed = true;
		if (held.length > 0) this.dispatch(held, "drain");
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private enqueue(entry: Entry<C>, seq: number, queue: QueueId): void {
		this.queues[queue].push({ ...entry, seq, queue, arrival: ++this.arrivals });
	}

	private take(queue: QueueId): Array<Logged<C>> {
		return this.queues[queue].splice(0);
	}

	private takeAll(): Array<Logged<C>> {
		return [...this.take("Q1"), ...this.take("Q2"), ...this.take("Q3")].sort((a, b) => a.arrival - b.arrival);
	}

	private all(): Array<Logged<C>> {
		return [...this.queues.Q1, ...this.queues.Q2, ...this.queues.Q3];
	}

	/** Something queued asks for a turn: typed input, or an event that wakes. */
	private triggers(): boolean {
		return this.all().some((each) => each.type === "input" || each.wake);
	}

	/** Decides, after anything changed, whether an idle session is handed a batch now, later (window) or not. */
	private pump(): void {
		if (this.disposed || this.inflight || isLocked(this.current) || isBusy(this.current)) return;
		if (this.current === "draining") return;
		if (this.queues.Q1.length > 0) {
			this.closeWindow();
			this.dispatch(this.takeAll(), "idle");
			return;
		}
		if (!this.triggers()) return;
		const ms = this.options.windowMs?.() ?? 0;
		if (ms <= 0) {
			this.closeWindow();
			this.dispatch(this.takeAll(), "idle");
		} else if (!this.timer) {
			this.timer = setTimeout(() => this.windowEnded(), ms);
			this.timer.unref?.();
		}
	}

	private windowEnded(): void {
		this.timer = undefined;
		if (this.disposed || this.inflight || isLocked(this.current) || isBusy(this.current)) return;
		if (this.all().length > 0) this.dispatch(this.takeAll(), "idle");
	}

	private closeWindow(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	/** Hands one batch over; the offset moves when it was taken, the entries return to their queues when it was not. */
	private dispatch(entries: Array<Logged<C>>, point: DeliveryPoint): void {
		const batch = buildBatch(this.options.catalog, entries);
		let sending: void | Promise<void>;
		try {
			sending = this.options.deliver(batch, point);
		} catch (error) {
			this.failed(batch.entries, error);
			return;
		}
		if (!isPromise(sending)) {
			this.delivered();
			return;
		}
		this.inflight = true;
		sending.then(
			() => {
				this.inflight = false;
				this.delivered();
			},
			(error: unknown) => {
				this.inflight = false;
				this.failed(batch.entries, error);
			},
		);
	}

	private delivered(): void {
		this.commit();
		if (this.current === "draining") this.signal("drained");
		this.pump();
	}

	private failed(entries: Array<Logged<C>>, error: unknown): void {
		for (const entry of entries) {
			this.queues[entry.queue].push(entry);
			this.queues[entry.queue].sort((a, b) => a.arrival - b.arrival);
		}
		if (this.current === "draining") this.signal("drained");
		this.options.onError(error);
	}

	/** The offset: just before the oldest event a queue still holds, else the newest the loop has seen. */
	private commit(): void {
		const held = this.all().filter((each) => each.seq > 0);
		const offset = held.length > 0 ? Math.min(...held.map((each) => each.seq)) - 1 : this.lastSeq;
		if (offset > 0) this.options.store.commit(offset);
	}
}
