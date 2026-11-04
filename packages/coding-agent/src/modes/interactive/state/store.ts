/**
 * One zustand vanilla store per interactive host. A slice adds a state key and an actions factory here without
 * reshaping the existing ones.
 */

import { createStore, type StoreApi } from "zustand/vanilla";
import {
	createEditorActions,
	initialEditorSlice,
	type EditorActions,
	type EditorSlice,
	type EditorState,
} from "./editor-slice.ts";
import {
	createOverlayActions,
	initialOverlaySlice,
	type OverlayActions,
	type OverlaySlice,
	type OverlayState,
} from "./overlay-slice.ts";
import {
	createQueueActions,
	initialQueueSlice,
	type QueueActions,
	type QueueSlice,
	type QueueState,
} from "./queue-slice.ts";
import { createViewActions, initialViewSlice, type ViewActions, type ViewSlice, type ViewState } from "./view-slice.ts";

type UiState = ViewState & QueueState & EditorState & OverlayState;
type UiActions = ViewActions & QueueActions & EditorActions & OverlayActions;
export type UiStore = StoreApi<UiState & UiActions>;

export function createUiStore(
	init: {
		view?: Partial<ViewSlice>;
		queue?: Partial<QueueSlice>;
		editor?: Partial<EditorSlice>;
		overlay?: Partial<OverlaySlice>;
	} = {},
): UiStore {
	return createStore<UiState & UiActions>()((set, get) => ({
		view: initialViewSlice(init.view),
		queue: initialQueueSlice(init.queue),
		editor: initialEditorSlice(init.editor),
		overlay: initialOverlaySlice(init.overlay),
		...createViewActions(set, get),
		...createQueueActions(set, get),
		...createEditorActions(set, get),
		...createOverlayActions(set, get),
	}));
}
