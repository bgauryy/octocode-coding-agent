import type { EventStore } from "./store.ts";
import type { Batch, DeliveryPoint, EventCatalog } from "./types.ts";

/** What an `EventLoop` needs from its host: the log, the catalog, delivery, error reporting and clocks. */
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
	/**
	 * Stops the step in progress for an urgent entry; the run then settles and the loop delivers. Absent, or a throw (the
	 * run cannot be stopped): the entry waits for the next step boundary like a regular one, still ahead of the others.
	 */
	interrupt?: () => void;
	now?: () => number;
}
