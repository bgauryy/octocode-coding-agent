/**
 * Status slice of the interactive UI store: the data the status lines keep besides their components. The status-line
 * code applies it when it creates or updates an indicator, so `bindRender` does not follow it.
 */

import type { StoreApi } from "zustand/vanilla";
import type { WorkingIndicatorOptions } from "../../../core/features/index.ts";

/** What the working indicator says while no feature set its own message. */
export const DEFAULT_WORKING_MESSAGE = "Working";

export interface StatusSlice {
	/** The working indicator's message as a feature set it (`ui.setWorkingMessage`); undefined for the default. */
	workingMessage: string | undefined;
	/** The working indicator's frames as a feature set them (`ui.setWorkingIndicator`); undefined for the default. */
	workingIndicator: WorkingIndicatorOptions | undefined;
	/** The managed-tool status lines (tool downloads at startup) have started: a spacer opened their group in the chat. */
	managedToolsStarted: boolean;
}

export interface StatusActions {
	setWorkingMessage(message: string | undefined): void;
	setWorkingIndicator(options: WorkingIndicatorOptions | undefined): void;
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
	managedToolsStarted: false,
	...init,
});

export const selectWorkingMessage = (state: StatusState): string =>
	state.status.workingMessage ?? DEFAULT_WORKING_MESSAGE;
export const selectWorkingIndicator = (state: StatusState): WorkingIndicatorOptions | undefined =>
	state.status.workingIndicator;

export function createStatusActions(set: Set, get: Get): StatusActions {
	const patch = (next: Partial<StatusSlice>) => set((state) => ({ status: { ...state.status, ...next } }));
	return {
		setWorkingMessage(message) {
			if (message === get().status.workingMessage) return;
			patch({ workingMessage: message });
		},
		setWorkingIndicator(options) {
			if (options === get().status.workingIndicator) return;
			patch({ workingIndicator: options });
		},
		startManagedToolStatus() {
			if (get().status.managedToolsStarted) return false;
			patch({ managedToolsStarted: true });
			return true;
		},
	};
}
