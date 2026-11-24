import type { FeatureSetup } from "../../core/features/index.ts";
import type { WakeLine } from "../../core/wake-entry.ts";
import type { Source } from "../events/source-types.ts";
import type { Priority } from "../events/loop/types.ts";
import type { PayloadEvent as AgentEvent } from "../events/topics.ts";

export type Message = Parameters<FeatureSetup["session"]["sendMessage"]>[0];
export type SendOptions = NonNullable<Parameters<FeatureSetup["session"]["sendMessage"]>[1]>;

/** Wake events remembered for the next row; older ones are dropped, as are events a run never started for. */
export const MAX_PENDING = 12;
export const PENDING_MAX_AGE_MS = 60_000;

/** An event waiting for the next row, with its dedupe key and how many sends still stand behind it. */
export interface Pending extends WakeLine {
	key: string;
	at: number;
	sends: number;
}

/**
 * A wake sent and not yet taken up by a run: its labels, and whether its send has settled. A send made while a run is in
 * progress or settling resolves before the turn it asks for can start (the host queues it, or defers it until the
 * `agent_settled` handlers return), so a settled send counts until a run starts or the settle ends (`agent_settle_end`).
 */
export interface Sent {
	labels: string[];
	answered: boolean;
}

export interface Held {
	/** Transcript entry reserved for a durable handoff. */
	entryId?: string;
	labels: string[];
	message: Message;
	options: SendOptions;
	done: { resolve: () => void; reject: (error: unknown) => void };
}

/** `B12`, `b12`, `#12` → `B12`; anything else is not an item reference. */
export function itemKey(ref: string | undefined): string | undefined {
	const seq = ref === undefined ? undefined : /^\s*(?:[bB]|#)?(\d{1,9})\s*$/.exec(ref)?.[1];
	return seq === undefined ? undefined : `B${Number(seq)}`;
}

/**
 * The session loop accepts a wake after its durable append succeeds.
 * Returns whether the loop took the event; false (an event it already holds) settles the send without sending.
 */
export type GateRoute = (entry: {
	/** The emit's events (one message may carry several, as a batch of mail does) and the source of each. */
	events: readonly AgentEvent[];
	sources: readonly Source[];
	priority: Priority;
	held: Held;
}) => boolean | Promise<boolean>;
