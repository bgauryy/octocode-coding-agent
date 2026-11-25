/**
 * Status slice of the interactive UI store: the indicator the status row (or the embedding editor) shows, described as
 * data, and the working message and frames features set. `bindStatusIndicator` mounts and updates the component and
 * asks for the frame; writers only dispatch actions, which skip a write that changes nothing.
 */

import type { StoreApi } from "zustand/vanilla";
import type { WorkingIndicatorOptions } from "../../../core/features/index.ts";
import type { CompactionProgress, StatusIndicatorKind } from "../components/status-indicator.ts";

/** What the working indicator says while no feature set its own message. */
export const DEFAULT_WORKING_MESSAGE = "Working";

/** The indicator to show, by kind. */
export type StatusIndicatorRequest =
	/** `wait`: the model-wait or cool-down text shown instead of the working message until it is cleared. */
	| { kind: "working"; wait?: string }
	| { kind: "compaction"; reason: "manual" | "threshold" | "overflow"; progress?: CompactionProgress }
	/** `offline`: the failure an outage shows on a static row instead of the numbered retry spinner. */
	| { kind: "retry"; attempt: number; maxAttempts: number; delayMs: number; offline?: string }
	| { kind: "branchSummary" };

/** The indicator in force; `seq` changes with every show, so showing one again mounts a fresh component. */
export type ShownStatusIndicator = StatusIndicatorRequest & { seq: number };

export interface StatusSlice {
	/** The working indicator's message as a feature set it (`ui.setWorkingMessage`); undefined for the default. */
	workingMessage: string | undefined;
	/** The working indicator's frames as a feature set them (`ui.setWorkingIndicator`); undefined for the default. */
	workingIndicator: WorkingIndicatorOptions | undefined;
	/** The indicator shown, if any. */
	indicator: ShownStatusIndicator | undefined;
	/** The managed-tool status lines (tool downloads at startup) have started: a spacer opened their group in the chat. */
	managedToolsStarted: boolean;
}

export interface StatusActions {
	setWorkingMessage(message: string | undefined): void;
	setWorkingIndicator(options: WorkingIndicatorOptions | undefined): void;
	/** Shows `request`, replacing any indicator in force. */
	showStatusIndicator(request: StatusIndicatorRequest): void;
	/** Removes the indicator; with `kind`, only when that kind is shown. */
	clearStatusIndicator(kind?: StatusIndicatorKind): void;
	/** Sets or clears the working indicator's wait text; ignored while another kind is shown. */
	setWorkingWait(wait: string | undefined): void;
	/** Updates a shown compaction's progress; ignored while another kind is shown. */
	setCompactionProgress(progress: CompactionProgress): void;
	/** Marks the managed-tool status lines started; true only for the first line, which opens their group. */
	startManagedToolStatus(): boolean;
}

export interface StatusState {
	status: StatusSlice;
}

type Get = StoreApi<StatusState & StatusActions>["getState"];
type Set = StoreApi<StatusState & StatusActions>["setState"];

export const initialStatusSlice = (init: Partial<StatusSlice> = {}): StatusSlice => ({
	workingMessage: undefined,
	workingIndicator: undefined,
	indicator: undefined,
	managedToolsStarted: false,
	...init,
});

export const selectWorkingMessage = (state: StatusState): string =>
	state.status.workingMessage ?? DEFAULT_WORKING_MESSAGE;
export const selectWorkingIndicator = (state: StatusState): WorkingIndicatorOptions | undefined =>
	state.status.workingIndicator;

export function createStatusActions(set: Set, get: Get): StatusActions {
	const patch = (next: Partial<StatusSlice>) => set((state) => ({ status: { ...state.status, ...next } }));
	let seq = 0;
	return {
		setWorkingMessage(message) {
			if (message === get().status.workingMessage) return;
			patch({ workingMessage: message });
		},
		setWorkingIndicator(options) {
			if (options === get().status.workingIndicator) return;
			patch({ workingIndicator: options });
		},
		showStatusIndicator(request) {
			seq += 1;
			patch({ indicator: { ...request, seq } });
		},
		clearStatusIndicator(kind) {
			const shown = get().status.indicator;
			if (!shown || (kind && shown.kind !== kind)) return;
			patch({ indicator: undefined });
		},
		setWorkingWait(wait) {
			const shown = get().status.indicator;
			if (shown?.kind !== "working" || shown.wait === wait) return;
			patch({ indicator: { ...shown, wait } });
		},
		setCompactionProgress(progress) {
			const shown = get().status.indicator;
			if (shown?.kind !== "compaction") return;
			patch({ indicator: { ...shown, progress } });
		},
		startManagedToolStatus() {
			if (get().status.managedToolsStarted) return false;
			patch({ managedToolsStarted: true });
			return true;
		},
	};
}
