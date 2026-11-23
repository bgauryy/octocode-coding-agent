/**
 * Fake InteractiveMode hosts for tests that drive one collaborator module directly. Like the mode's own host, the
 * fake gets every module-backed method, except the ones the test defines on it.
 */

import { createStore } from "zustand/vanilla";
import type { InteractiveModeHost } from "../src/modes/interactive/interactive-mode/host.ts";
import { interactiveModeMethodImplementations } from "../src/modes/interactive/interactive-mode/host-methods.ts";
import type { CompactionQueuedMessage } from "../src/modes/interactive/interactive-mode/types.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";

export { bindQueueState, renderPendingMessages } from "../src/modes/interactive/state/bind-queue.ts";

/** A stand-in for the application service's state source, fed from a fake session's queues by `sync`. */
export function fakeQueueService(session: {
	getSteeringMessages(): string[];
	getFollowUpMessages(): string[];
	isCompacting?: boolean;
}) {
	const store = createStore<{ steering: string[]; followUp: string[]; status: "idle" | "compacting" }>()(() => ({
		steering: [],
		followUp: [],
		status: "idle",
	}));
	const source = {
		getState: () => store.getState() as never,
		subscribe: (l: () => void) => store.subscribe(() => l()),
	};
	const sync = () =>
		store.setState({
			steering: session.getSteeringMessages(),
			followUp: session.getFollowUpMessages(),
			status: session.isCompacting ? "compacting" : "idle",
		});
	return { source, sync };
}

/** A UI store whose queue slice already holds `compaction` messages. */
export function heldStore(compaction: CompactionQueuedMessage[] = []) {
	return createUiStore({ queue: { compaction } });
}

/**
 * Adds the missing host methods to `fake`, and a UI store when it has none (the mode's host always has one), and
 * returns it typed as a host.
 */
export function createFakeHost<T extends object>(fake: T): T & InteractiveModeHost {
	if (!("uiStore" in fake)) Object.assign(fake, { uiStore: createUiStore() });
	const methods = fake as Record<string, unknown>;
	for (const [name, implementation] of Object.entries(interactiveModeMethodImplementations)) {
		if (name in fake) continue;
		const call = implementation as (host: T, ...args: unknown[]) => unknown;
		methods[name] = (...args: unknown[]) => call(fake, ...args);
	}
	return fake as T & InteractiveModeHost;
}
