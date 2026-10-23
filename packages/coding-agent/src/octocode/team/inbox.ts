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
	private urgent: number | undefined;
	/** Seen by the model, not yet recorded (the database was busy): recorded on the next tick. */
	private readonly seenIds = new Set<number>();
	/** The recipient, hand-off point and database stamp at which a read found nothing waiting. */
	private idleAt: string | undefined;

	/** Only newly handed mail needs a context scan; earlier conversation mail is already accounted for. */
	get awaitingContext(): boolean {
		return this.unseen.size > 0;
	}

	/** Forgets everything (the agent left); with the database, first records what the model saw, if it can. */
	reset(db?: TeamStore, id?: string): void {
		try {
			if (db && id) this.record(db, id);
		} catch {
			// Busy database: unrecorded mail becomes a dead letter.
		}
		this.handed = 0;
		this.unseen.clear();
		this.urgent = undefined;
		this.seenIds.clear();
		this.idleAt = undefined;
	}

	/** Records what the model saw, then hands the next batch to `send`; a refused batch is offered again next tick. */
	deliver(db: TeamStore, id: string, send: (batch: Message[]) => boolean, idle = false): void {
		this.record(db, id);
		// Taken before the reads: a write that lands after it moves the stamp, so the next tick reads.
		const stamp = db.stamp();
		const state = () => `${id}|${this.handed}|${stamp}`;
		if (state() === this.idleAt) return;
		if (this.handed > 0 && db.waitingThrough(id, this.handed).some((message) => !this.unseen.has(message))) {
			this.handed = 0;
			this.unseen.clear();
			this.urgent = undefined;
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
			if (!send([urgent])) {
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
		if (send(batch)) return;
		this.handed = before;
		for (const message of batch) this.unseen.delete(message.id);
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
