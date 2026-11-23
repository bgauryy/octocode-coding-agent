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
	createInputActions,
	initialInputSlice,
	type InputActions,
	type InputSlice,
	type InputState,
} from "./input-slice.ts";
import {
	createLifecycleActions,
	initialLifecycleSlice,
	type LifecycleActions,
	type LifecycleSlice,
	type LifecycleState,
} from "./lifecycle-slice.ts";
import {
	createNoticesActions,
	initialNoticesSlice,
	type NoticesActions,
	type NoticesSlice,
	type NoticesState,
} from "./notices-slice.ts";
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
import {
	createStatusActions,
	initialStatusSlice,
	type StatusActions,
	type StatusSlice,
	type StatusState,
} from "./status-slice.ts";
import { createViewActions, initialViewSlice, type ViewActions, type ViewSlice, type ViewState } from "./view-slice.ts";

export type UiState = ViewState &
	QueueState &
	EditorState &
	OverlayState &
	InputState &
	NoticesState &
	StatusState &
	LifecycleState;
type UiActions = ViewActions &
	QueueActions &
	EditorActions &
	OverlayActions &
	InputActions &
	NoticesActions &
	StatusActions &
	LifecycleActions;
export type UiStore = StoreApi<UiState & UiActions>;

export function createUiStore(
	init: {
		view?: Partial<ViewSlice>;
		queue?: Partial<QueueSlice>;
		editor?: Partial<EditorSlice>;
		overlay?: Partial<OverlaySlice>;
		input?: Partial<InputSlice>;
		notices?: Partial<NoticesSlice>;
		status?: Partial<StatusSlice>;
		lifecycle?: Partial<LifecycleSlice>;
	} = {},
): UiStore {
	return createStore<UiState & UiActions>()((set, get) => ({
		view: initialViewSlice(init.view),
		queue: initialQueueSlice(init.queue),
		editor: initialEditorSlice(init.editor),
		overlay: initialOverlaySlice(init.overlay),
		input: initialInputSlice(init.input),
		notices: initialNoticesSlice(init.notices),
		status: initialStatusSlice(init.status),
		lifecycle: initialLifecycleSlice(init.lifecycle),
		...createViewActions(set, get),
		...createQueueActions(set, get),
		...createEditorActions(set, get),
		...createOverlayActions(set, get),
		...createInputActions(set, get),
		...createNoticesActions(set, get),
		...createStatusActions(set, get),
		...createLifecycleActions(set, get),
	}));
}
