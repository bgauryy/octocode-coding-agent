import type { Entry, Logged, Priority, QueueId } from "./types.ts";

/** Typed input is the user's next task; an event has its own priority. */
const priorityOf = (entry: Entry<unknown>): Priority => (entry.type === "event" ? entry.priority : "regular");

/** The order of one batch: urgent entries first, then arrival. */
const inOrder = (a: Logged<unknown>, b: Logged<unknown>): number =>
	Number(priorityOf(b) === "urgent") - Number(priorityOf(a) === "urgent") || a.arrival - b.arrival;

/** Entries waiting for a safe boundary. Arrival and wake decisions are O(1), including during an idle burst. */
export class LoopQueues<C> {
	private readonly queues: Record<QueueId, Array<Logged<C>>> = { Q1: [], Q2: [], Q3: [] };
	private readonly oldest: Record<QueueId, number> = { Q1: Infinity, Q2: Infinity, Q3: Infinity };
	private arrivals = 0;
	private waitingWakes = 0;
	private idleUrgent = false;

	get hasWake(): boolean {
		return this.waitingWakes > 0;
	}

	get immediate(): boolean {
		return this.queues.Q1.length > 0 || this.idleUrgent;
	}

	get empty(): boolean {
		return !this.queues.Q1.length && !this.queues.Q2.length && !this.queues.Q3.length;
	}

	counts(): Record<QueueId, number> {
		return { Q1: this.queues.Q1.length, Q2: this.queues.Q2.length, Q3: this.queues.Q3.length };
	}

	sequences(): Set<number> {
		const result = new Set<number>();
		for (const queue of Object.values(this.queues)) for (const entry of queue) result.add(entry.seq);
		return result;
	}

	safeOffset(lastSeq: number): number {
		return Math.min(lastSeq, this.oldest.Q2 - 1, this.oldest.Q3 - 1);
	}

	enqueue(entry: Entry<C>, seq: number, queue: QueueId, arrival = ++this.arrivals): void {
		const logged = { ...entry, seq, queue, arrival };
		this.queues[queue].push(logged);
		this.count(logged);
	}

	private count(entry: Logged<C>): void {
		const { queue, seq } = entry;
		if (seq > 0) this.oldest[queue] = Math.min(this.oldest[queue], seq);
		if (entry.type === "input" || entry.wake) this.waitingWakes++;
		if (queue === "Q3" && priorityOf(entry) === "urgent") this.idleUrgent = true;
	}

	private take(queue: QueueId): Array<Logged<C>> {
		const entries = this.queues[queue];
		this.queues[queue] = [];
		this.oldest[queue] = Infinity;
		if (queue === "Q3") this.idleUrgent = false;
		for (const entry of entries) if (entry.type === "input" || entry.wake) this.waitingWakes--;
		return entries;
	}

	takeBatch(boundary = false): Array<Logged<C>> {
		const entries = this.take("Q1").concat(this.take("Q2"));
		return (boundary ? entries : entries.concat(this.take("Q3"))).sort(inOrder);
	}

	startRun(): void {
		const idle = this.queues.Q3;
		if (idle.length === 0) return;
		for (const entry of idle) entry.queue = "Q2";
		this.queues.Q2 = this.queues.Q2.length ? this.queues.Q2.concat(idle) : idle;
		this.queues.Q3 = [];
		this.idleUrgent = false;
		this.oldest.Q2 = Math.min(this.oldest.Q2, this.oldest.Q3);
		this.oldest.Q3 = Infinity;
	}

	restore(entries: Array<Logged<C>>): void {
		const returned: Record<QueueId, Array<Logged<C>>> = { Q1: [], Q2: [], Q3: [] };
		for (const entry of entries) {
			returned[entry.queue].push(entry);
			this.count(entry);
		}
		for (const queue of ["Q1", "Q2", "Q3"] as const) {
			if (returned[queue].length) this.queues[queue] = returned[queue].concat(this.queues[queue]);
		}
	}
}
