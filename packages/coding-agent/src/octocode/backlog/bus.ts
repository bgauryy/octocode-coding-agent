import type { backlog } from "../../../../db/src/api.ts";
import type { BacklogChange, BacklogChangeNotice } from "../shared/backlog-change.ts";
import { type AuditRow, classify } from "../shared/backlog-classify.ts";

/** Audit rows read per query; a longer gap is read in pages. */
const PAGE = 200;

/** What a listener hears: a change, or that rows were pruned before they were read (what it collected is stale). */
export type BusEvent = ({ type: "change" } & BacklogChangeNotice) | { type: "resync" };

/** What the bus reads from the database and the follower. */
export interface BusHost {
	/** The workspace's newest audit id now: where the first listener starts. */
	head(): number;
	/** The audit rows after `after` (`backlog.auditAfter`). */
	after(after: number, limit: number): backlog.AuditPage;
	/** Calls `poke` whenever the database file may have changed (`DatabaseFollower`); returns the unsubscribe. */
	follow(poke: () => void): () => void;
	/** Whether this process wrote a row by actor `by`. */
	own(by: string): boolean;
	/** A listener threw: the others still heard the event and the cursor moved on. */
	failed(error: unknown): void;
}

/**
 * The backlog's change feed, derived from the audit log and never written separately, so it cannot disagree with it. It
 * reads the rows after its cursor only when the database follower fires, from the moment the first listener arrives, and
 * stops following when the last one leaves. Each audit row is classified once (`classify`) and handed to every listener
 * with whether this process wrote it.
 */
export class BacklogBus {
	private readonly listeners = new Set<(event: BusEvent) => void>();
	private cursor: number | undefined;
	private unfollow: (() => void) | undefined;
	private readonly host: BusHost;

	constructor(host: BusHost) {
		this.host = host;
	}

	get listening(): number {
		return this.listeners.size;
	}

	/** Calls `listener` for every change from now on; the returned function stops it. */
	on(listener: (event: BusEvent) => void): () => void {
		if (this.listeners.size === 0) {
			this.cursor = this.host.head();
			this.unfollow = this.host.follow(() => this.poll());
		}
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size > 0) return;
			this.unfollow?.();
			this.unfollow = undefined;
			this.cursor = undefined;
		};
	}

	/** Reads the rows after the cursor and emits each change; a listener that throws is reported, the others still hear it. */
	poll(): void {
		if (this.cursor === undefined) return;
		for (;;) {
			const page = this.host.after(this.cursor, PAGE);
			this.cursor = page.cursor;
			if (page.resync) {
				this.emit({ type: "resync" });
				return;
			}
			for (const row of page.rows) this.take(row);
			if (!page.more) return;
		}
	}

	private take(row: AuditRow): void {
		const change: BacklogChange | undefined = classify(row);
		if (change) this.emit({ type: "change", change, own: this.host.own(change.by) });
	}

	private emit(event: BusEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				this.host.failed(error);
			}
		}
	}
}
