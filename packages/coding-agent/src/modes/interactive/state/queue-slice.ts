/**
 * Queue slice of the interactive UI store: the messages the interface itself holds while the agent cannot take them
 * (compaction running, or carried across a session switch). The session's steering and follow-up queues belong to the
 * application service; the pending-messages area reads them from its read-only state source, never from a copy here.
 */

import type { StoreApi } from "zustand/vanilla";
import type { CompactionQueuedMessage } from "../interactive-mode/types.ts";

export interface QueueSlice {
	/** Held messages in queue order; replaced (never mutated) on each change. */
	compaction: readonly CompactionQueuedMessage[];
}

export interface QueueActions {
	/** Appends a held message. */
	holdMessage(message: CompactionQueuedMessage): void;
	/**
	 * Applies `edit` to a copy of the held messages and publishes the copy: call it only for a real change, since the
	 * pending area redraws on each publication. Messages mutated in place (mode, text) belong in the same `edit`.
	 */
	editHeldMessages(edit: (held: CompactionQueuedMessage[]) => void): void;
	/**
	 * Removes and returns the held messages, in order: all of them, or only those carried over a session switch
	 * (`carried: true`) or only those held for compaction (`carried: false`). Taking none publishes nothing.
	 */
	takeHeldMessages(carried?: boolean): CompactionQueuedMessage[];
}

export interface QueueState {
	queue: QueueSlice;
}

type Get = StoreApi<QueueState & QueueActions>["getState"];
type Set = StoreApi<QueueState & QueueActions>["setState"];

export const initialQueueSlice = (init: Partial<QueueSlice> = {}): QueueSlice => ({ compaction: [], ...init });

export const selectHeldMessages = (state: QueueState): readonly CompactionQueuedMessage[] => state.queue.compaction;

export function createQueueActions(set: Set, get: Get): QueueActions {
	const publish = (compaction: CompactionQueuedMessage[]) => set({ queue: { compaction } });
	return {
		holdMessage(message) {
			publish([...get().queue.compaction, message]);
		},
		editHeldMessages(edit) {
			const next = [...get().queue.compaction];
			edit(next);
			publish(next);
		},
		takeHeldMessages(carried) {
			const all = get().queue.compaction;
			const matches = (message: CompactionQueuedMessage) => carried === undefined || !!message.carried === carried;
			const taken = all.filter(matches);
			if (taken.length > 0) publish(all.filter((message) => !matches(message)));
			return taken;
		},
	};
}
