import { withSessionStorage } from "../../../storage/runtime-paths.ts";
import { onlyReadsMessages, readsMessagesOnly } from "../runner/clone-messages.ts";
import type { FeatureRecord, FeatureContext } from "../types.ts";
import type { BusEventType } from "./events.ts";

/** A subscribed handler as the bus stores it. */
export type BusHandler = (...args: unknown[]) => unknown;

/** One feature's handlers for one event, in registration order. */
export interface BusBucket {
	readonly feature: FeatureRecord;
	readonly handlers: BusHandler[];
}

/**
 * Subscribe `handler` to `event` in `feature`'s bucket. The handler runs with the session's storage, keeps its
 * `readsMessagesOnly` mark, and the returned function removes this one registration.
 */
export function subscribe(feature: FeatureRecord, event: string, handler: BusHandler): () => void {
	const registered: BusHandler = (payload, context) =>
		withSessionStorage((context as FeatureContext | undefined)?.sessionManager, () => handler(payload, context));
	if (onlyReadsMessages(handler)) readsMessagesOnly(registered);
	const list = feature.handlers.get(event) ?? [];
	list.push(registered);
	feature.handlers.set(event, list);
	return () => {
		const handlers = feature.handlers.get(event);
		const index = handlers?.indexOf(registered) ?? -1;
		if (!handlers || index === -1) return;
		handlers.splice(index, 1);
		if (handlers.length === 0) feature.handlers.delete(event);
	};
}

/**
 * The session's subscriptions: one bucket per feature, in feature load order. A dispatch reads a snapshot, so a
 * handler subscribed during a dispatch runs from the next one on, and a late subscription by an earlier feature
 * still runs before every later feature's handlers.
 */
export class SessionBus {
	private readonly features: readonly FeatureRecord[];

	constructor(features: readonly FeatureRecord[]) {
		this.features = features;
	}

	/** Whether any feature handles `event`, so core can skip building it. */
	has(event: BusEventType): boolean {
		return this.features.some((feature) => (feature.handlers.get(event)?.length ?? 0) > 0);
	}

	/** The buckets of `event`, copied at call time. */
	snapshot(event: BusEventType): BusBucket[] {
		return this.features.map((feature) => ({ feature, handlers: feature.handlers.get(event)?.slice() ?? [] }));
	}

	/** Every handler of `event`, flattened in dispatch order. */
	handlers(event: BusEventType): BusHandler[] {
		return this.snapshot(event).flatMap((bucket) => bucket.handlers);
	}
}
