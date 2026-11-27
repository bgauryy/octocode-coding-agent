import { pendingEntryWrite } from "../../core/session-manager/entry-receipt.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { attachCustomReceipt } from "../../core/agent-session/custom-receipt.ts";
import type { AgentEvent } from "../events/topics.ts";
import type { EventStore } from "../events/loop/store.ts";
import type { NewAgentEvent } from "../events/loop/rows.ts";
import type { Held } from "./gate-types.ts";

/**
 * The dispatcher can hand work to a running session before the session records it. Hold its cursor while a durable
 * message is in transit. On restart the transcript's indexed entry IDs distinguish accepted siblings beyond that cursor.
 */
export class DeliveryReceipts implements EventStore {
	private desired = 0;
	private written = 0;
	private floor = Infinity;
	private waiting = 0;
	private writing?: Promise<void>;

	private readonly log: EventStore;
	private readonly getEntry: (id: string) => SessionEntry | undefined;
	private readonly failed: (error: unknown) => void;

	constructor(log: EventStore, getEntry: (id: string) => SessionEntry | undefined, failed: (error: unknown) => void) {
		this.log = log;
		this.getEntry = getEntry;
		this.failed = failed;
	}

	append(event: NewAgentEvent) {
		return this.log.append(event);
	}
	unread(limit?: number, after?: number): AgentEvent[] {
		return this.log.unread(limit, after);
	}
	offset(): number {
		this.written = this.log.offset();
		return this.written;
	}
	commit(seq: number): void | Promise<void> {
		this.desired = Math.max(this.desired, seq);
		return this.flush();
	}

	async settled(): Promise<void> {
		await this.writing;
		await this.log.settled?.();
	}

	private flush(): void | Promise<void> {
		if (this.writing) return this.writing;
		const safe = Math.min(this.desired, this.floor);
		if (safe <= this.written) return;
		const write = this.log.commit(safe);
		if (!write) {
			this.written = safe;
			return;
		}
		this.writing = write.then(
			() => {
				this.written = safe;
				this.writing = undefined;
				return this.flush();
			},
			(error: unknown) => {
				this.writing = undefined;
				throw error;
			},
		);
		return this.writing;
	}

	/** An older pending envelope predates entry IDs. Its log sequence stays stable across replays. */
	idOf(event: AgentEvent): string {
		return typeof event.body?.entryId === "string" ? event.body.entryId : `wake-${event.seq}`;
	}

	unrecorded(event: AgentEvent): boolean {
		const entry = this.getEntry(this.idOf(event));
		if (!entry) return true;
		const writing = pendingEntryWrite(entry);
		if (writing) void writing.then(this.hold(event.seq), this.failed);
		return false;
	}

	private hold(seq: number): () => void {
		this.waiting++;
		this.floor = Math.min(this.floor, seq - 1);
		return () => {
			if (--this.waiting !== 0) return;
			this.floor = Infinity;
			try {
				this.flush()?.catch(this.failed);
			} catch (error) {
				this.failed(error);
			}
		};
	}

	sending(seq: number, held: Held): void {
		if (!held.entryId) return;
		const release = this.hold(seq);
		let accepted = false;
		const reject = held.done.reject;
		held.done.reject = (error) => {
			if (!accepted) reject(error);
		};
		attachCustomReceipt(held.message, {
			entryId: held.entryId,
			recorded: () => {
				if (accepted) return;
				accepted = true;
				release();
			},
		});
	}
}
