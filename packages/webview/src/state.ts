import type { WorkspaceEvent, WorkspaceSnapshot } from "@octocodeai/octocode-contacts/workspace";
import { createStore } from "zustand/vanilla";

export type ActivityFilter = "all" | "results" | "tools" | "agents" | "attention";
export interface WorkspaceDraft {
	text: string;
	to?: string;
	id: string;
	version?: number;
}
interface WorkspaceState {
	drafts: Record<string, WorkspaceDraft>;
	setDraft: (key: string, draft: WorkspaceDraft | null) => void;
	snapshot: WorkspaceSnapshot | null;
	filter: ActivityFilter;
	paused: boolean;
	displayedEvents: WorkspaceEvent[];
	accept: (snapshot: WorkspaceSnapshot) => void;
	setFilter: (filter: ActivityFilter) => void;
	setPaused: (paused: boolean) => void;
}

/** Each browser owns a store; credentials and agent content are never persisted. */
export function createWorkspaceStore() {
	return createStore<WorkspaceState>()((set) => ({
		drafts: {},
		setDraft: (key, draft) =>
			set((state) => {
				const drafts = { ...state.drafts };
				if (draft) drafts[key] = draft;
				else delete drafts[key];
				return { drafts };
			}),
		snapshot: null,
		filter: "all",
		paused: false,
		displayedEvents: [],
		accept: (snapshot) =>
			set((state) => {
				const changedSession = state.snapshot !== null && state.snapshot.sessionId !== snapshot.sessionId;
				if (changedSession) return { snapshot, drafts: {}, paused: false, displayedEvents: snapshot.events };
				const sameEvents = JSON.stringify(state.displayedEvents) === JSON.stringify(snapshot.events);
				return { snapshot, displayedEvents: state.paused || sameEvents ? state.displayedEvents : snapshot.events };
			}),
		setFilter: (filter) => set({ filter }),
		setPaused: (paused) =>
			set((state) => ({ paused, displayedEvents: paused ? state.displayedEvents : (state.snapshot?.events ?? []) })),
	}));
}

export function selectEvents(state: Pick<WorkspaceState, "displayedEvents" | "filter">) {
	return state.displayedEvents
		.filter(
			(event) =>
				state.filter === "all" ||
				(state.filter === "attention"
					? event.outcome === "failed" ||
						(typeof event.details === "object" &&
							event.details !== null &&
							"status" in event.details &&
							["failed", "error", "blocked"].includes(String(event.details.status)))
					: state.filter === "results"
						? event.type.endsWith(".result")
						: event.type.startsWith(state.filter === "tools" ? "tool." : "agent.")),
		)
		.slice()
		.reverse();
}
