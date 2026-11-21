import type { Message } from "./model.ts";
import type { TeamStore } from "./store.ts";

/**
 * Whole-message delivery with backpressure. A normal batch stays in flight until context acknowledges it;
 * remaining mail stays in SQLite. One control message may pass it: an interrupt, or an idle recipient's
 * waking request. The byte budget never splits a message; a single oversized message travels alone.
 */
const INBOX_BATCH_BYTES = 32 * 1024;

export class Inbox {
	/** The newest message handed to Octocode: later ticks hand over only newer ones, so none is injected twice. */
	private handed = 0;
	/** Handed to Octocode, not yet seen by the model. */
	private readonly unseen = new Set<number>();
	/**
	 * Rows to hand over by id, below the watermark: a handoff rejected asynchronously (another attempt next tick), or mail
	 * that arrived below it (a forward or relay of an older message), so mail still in flight is not handed over twice.
	 */
	private readonly retry = new Set<number>();
	private urgent: number | undefined;
	/** Seen by the model, not yet recorded (the database was busy): recorded on the next tick. */
	private readonly seenIds = new Set<number>();
	/** The recipient, hand-off point and database stamp at which a read found nothing waiting. */
	private idleAt: string | undefined;
	private generation = 0;
	/** Seen by a model whose agent left before they could be recorded (the database was busy), and the id it left under. */
	private unrecorded: { id: string; ids: number[] } | undefined;

	/** Only newly handed mail needs a context scan; earlier conversation mail is already accounted for. */
	get awaitingContext(): boolean {
		return this.unseen.size > 0;
	}

	/** Forgets everything (the agent left); with the database, first records what the model saw, if it can. */
	reset(db?: TeamStore, id?: string): void {
		this.generation++;
		const left = this.seenIds.size > 0 && id ? { id, ids: [...this.seenIds] } : undefined;
		try {
			if (db && id) db.quick(() => this.record(db, id));
		} catch {
			// Busy database: the next `deliver` records them under the id the agent left with.
			if (left) this.unrecorded = left;
		}
		this.handed = 0;
		this.unseen.clear();
		this.retry.clear();
		this.urgent = undefined;
		this.seenIds.clear();
		this.idleAt = undefined;
	}

	/** Records what the model saw, then hands the next batch to `send`; a refused batch is offered again next tick. */
	deliver(db: TeamStore, id: string, send: (batch: Message[], onRejected: () => void) => boolean, idle = false): void {
		if (this.unrecorded) {
			db.ack(this.unrecorded.id, this.unrecorded.ids);
			this.unrecorded = undefined;
		}
		this.record(db, id);
		// Taken before the reads: a write that lands after it moves the stamp, so the next tick reads.
		const stamp = db.stamp();
		const state = () => `${id}|${this.handed}|${stamp}`;
		if (state() === this.idleAt) return;
		if (this.handed > 0)
			for (const late of db.waitingThrough(id, this.handed)) if (!this.unseen.has(late)) this.retry.add(late);
		if (this.retry.size > 0) {
			const first = Math.min(...this.retry);
			const batch = db.pending(id, first - 1).filter((message) => this.retry.has(message.id));
			if (batch.length === 0) {
				// The first rejected row is no longer pending. Later failed rows may be beyond the bounded read.
				this.retry.delete(first);
				return;
			} else {
				for (const message of batch) {
					this.retry.delete(message.id);
					this.unseen.add(message.id);
				}
				if (!send(batch, this.onRejected(batch))) {
					for (const message of batch) {
						this.unseen.delete(message.id);
						this.retry.add(message.id);
					}
				}
				return;
			}
		}
		if (db.waiting(id, this.handed) === 0) {
			this.idleAt = state();
			return;
		}
		if (this.unseen.size > 0) {
			if (this.urgent !== undefined) return;
			const urgent = db.pendingUrgent(id, this.handed, idle);
			if (!urgent || this.unseen.has(urgent.id)) return;
			this.urgent = urgent.id;
			this.unseen.add(urgent.id);
			if (!send([urgent], this.onRejected([urgent]))) {
				this.unseen.delete(urgent.id);
				this.urgent = undefined;
			}
			return;
		}
		const batch: Message[] = [];
		let bytes = 2;
		for (const message of db.pending(id, this.handed)) {
			const size = Buffer.byteLength(JSON.stringify(message)) + (batch.length > 0 ? 1 : 0);
			if (batch.length > 0 && bytes + size > INBOX_BATCH_BYTES) break;
			batch.push(message);
			bytes += size;
		}
		if (batch.length === 0) return; // Another process can remove the recipient between the two reads.
		const before = this.handed;
		// Marked first: Octocode may call the model with the batch, and report it seen, before `send` returns.
		this.handed = batch.at(-1)!.id;
		for (const message of batch) this.unseen.add(message.id);
		if (send(batch, this.onRejected(batch))) return;
		this.handed = before;
		for (const message of batch) this.unseen.delete(message.id);
	}

	private onRejected(batch: Message[]): () => void {
		const generation = this.generation;
		return () => {
			if (generation !== this.generation) return;
			for (const message of batch) {
				if (this.unseen.delete(message.id)) this.retry.add(message.id);
				if (this.urgent === message.id) this.urgent = undefined;
			}
			this.idleAt = undefined;
		};
	}

	/**
	 * The model is being called with these messages in its conversation: record the ones this inbox handed over and has
	 * not recorded yet (the conversation repeats every earlier message on every call). Retried on the next tick when the
	 * database is busy.
	 */
	seen(db: TeamStore, id: string, messages: number[]): void {
		for (const message of messages) {
			if (this.unseen.delete(message)) this.seenIds.add(message);
			if (this.urgent === message) this.urgent = undefined;
		}
		this.record(db, id);
	}

	private record(db: TeamStore, id: string): void {
		if (this.seenIds.size === 0) return;
		db.ack(id, [...this.seenIds]);
		this.seenIds.clear();
	}
}
