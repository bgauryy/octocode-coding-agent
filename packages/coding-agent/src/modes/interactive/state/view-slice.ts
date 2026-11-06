/**
 * View slice of the interactive UI store: tool-output expansion, thinking-block visibility and the latest toggle
 * acknowledgement. Slices are plain objects replaced immutably so `watchSelection` equality stays cheap.
 */

import type { StoreApi } from "zustand/vanilla";

/** A toggle acknowledgement for the messages list; `seq` tells a repeated text apart from the one already said. */
export interface ViewNotice {
	text: string;
	seq: number;
}

export interface ViewSlice {
	toolsExpanded: boolean;
	hideThinking: boolean;
	notice: ViewNotice | undefined;
}

export interface ViewActions {
	setToolsExpanded(expanded: boolean): void;
	toggleToolsExpanded(): void;
	setHideThinking(hide: boolean): void;
	/**
	 * Says `text` once in the messages list, as a display-only status line that is neither recorded in the session nor
	 * sent to the model; back-to-back notices share one line (`showStatus` coalesces them).
	 */
	showNotice(text: string): void;
}

export interface ViewState {
	view: ViewSlice;
}

type Get = StoreApi<ViewState & ViewActions>["getState"];
type Set = StoreApi<ViewState & ViewActions>["setState"];

export const initialViewSlice = (init: Partial<ViewSlice> = {}): ViewSlice => ({
	toolsExpanded: false,
	hideThinking: false,
	notice: undefined,
	...init,
});

export const selectToolsExpanded = (state: ViewState): boolean => state.view.toolsExpanded;
export const selectHideThinking = (state: ViewState): boolean => state.view.hideThinking;
export const selectNotice = (state: ViewState): ViewNotice | undefined => state.view.notice;

function patchView(set: Set, patch: Partial<ViewSlice>): void {
	set((state) => ({ view: { ...state.view, ...patch } }));
}

export function createViewActions(set: Set, get: Get): ViewActions {
	return {
		setToolsExpanded(expanded) {
			if (expanded === get().view.toolsExpanded) return;
			patchView(set, { toolsExpanded: expanded });
			get().showNotice(`Tool output: ${expanded ? "expanded" : "collapsed"}`);
		},
		toggleToolsExpanded() {
			get().setToolsExpanded(!get().view.toolsExpanded);
		},
		setHideThinking(hide) {
			if (hide === get().view.hideThinking) return;
			patchView(set, { hideThinking: hide });
		},
		showNotice(text) {
			patchView(set, { notice: { text, seq: (get().view.notice?.seq ?? 0) + 1 } });
		},
	};
}
