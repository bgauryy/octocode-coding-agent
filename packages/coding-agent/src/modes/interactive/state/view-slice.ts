/**
 * View slice of the interactive UI store: tool-output expansion, thinking-block visibility and the transient
 * footer notice. Slices are plain objects replaced immutably so `watchSelection` equality stays cheap.
 */

import type { StoreApi } from "zustand/vanilla";

/** How long a toggle acknowledgement stays in the footer. */
const NOTICE_MS = 2000;

export interface ViewNotice {
	text: string;
	/** Epoch milliseconds after which the notice clears itself. */
	until: number;
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
	/** Shows `text` in the footer for `ms` milliseconds; a newer notice replaces the current one. */
	showNotice(text: string, ms?: number): void;
	clearNotice(): void;
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
	let timer: ReturnType<typeof setTimeout> | undefined;
	const clearNotice = () => {
		clearTimeout(timer);
		timer = undefined;
		if (get().view.notice) patchView(set, { notice: undefined });
	};
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
		showNotice(text, ms = NOTICE_MS) {
			clearTimeout(timer);
			patchView(set, { notice: { text, until: Date.now() + ms } });
			timer = setTimeout(clearNotice, ms);
			timer.unref?.();
		},
		clearNotice,
	};
}
