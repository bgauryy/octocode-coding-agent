import { createStore } from "zustand/vanilla";
import type { WorkspaceEvent } from "@octocodeai/octocode-contracts/workspace";

interface WorkspaceRuntimeState {
	sessionId: string | undefined;
	sequence: number;
	events: readonly WorkspaceEvent[];
}

/** Extension-scoped activity, including SDK hosts that have no application session attached. */
export function createWorkspaceRuntimeState() {
	return createStore<WorkspaceRuntimeState>()(() => ({ sessionId: undefined, sequence: 0, events: [] }));
}

export function appendWorkspaceEvent(
	store: ReturnType<typeof createWorkspaceRuntimeState>,
	input: Omit<WorkspaceEvent, "id">,
): void {
	store.setState((state) => {
		const sequence = state.sequence + 1;
		const events = [...state.events, { ...input, id: sequence }];
		while (events.length > 200 || (events.length > 1 && JSON.stringify(events).length > 262144)) events.shift();
		return { sequence, events };
	});
}
