import type { AgentEvent } from "../topics.ts";
import type { NewAgentEvent } from "./rows.ts";

/**
 * Where the loop writes what it hears and how far it has delivered. `append` gives an event its place in the order (and
 * drops one whose dedupe key is already held); `commit` moves the delivery offset forward after a batch was handed to the
 * session; `unread` is what a restarted loop replays. The shadow loop uses the memory store, so it acts on nothing outside
 * the process; `db-store.ts` is the durable one.
 */
export interface EventStore {
	append(event: NewAgentEvent): { seq: number; inserted: boolean };
	/** The `seq` of the last event delivered. */
	offset(): number;
	/** Records that every event up to `seq` was delivered; never moves back. */
	commit(seq: number): void;
	/** Events after the offset, oldest first. */
	unread(limit?: number): AgentEvent[];
}

export class MemoryEventStore implements EventStore {
	private readonly log: AgentEvent[] = [];
	private readonly byDedupe = new Map<string, number>();
	private delivered = 0;
	private seq = 0;

	append(event: NewAgentEvent): { seq: number; inserted: boolean } {
		const earlier = event.dedupeKey === undefined ? undefined : this.byDedupe.get(event.dedupeKey);
		if (earlier !== undefined) return { seq: earlier, inserted: false };
		const seq = ++this.seq;
		this.log.push({ ...event, seq });
		if (event.dedupeKey !== undefined) this.byDedupe.set(event.dedupeKey, seq);
		return { seq, inserted: true };
	}

	offset(): number {
		return this.delivered;
	}

	commit(seq: number): void {
		this.delivered = Math.max(this.delivered, seq);
	}

	unread(limit = 200): AgentEvent[] {
		return this.log.filter((event) => event.seq > this.delivered).slice(0, limit);
	}
}
