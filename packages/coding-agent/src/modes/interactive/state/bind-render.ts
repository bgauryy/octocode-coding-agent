/**
 * Asks for a frame when the editor slot changes hands. The other drawn slices ask through the binder that applies them
 * (`bind-view.ts`, `bind-editor.ts`, `bind-queue.ts`, `bind-status.ts`), and only when a drawn row changed, so a store
 * write nothing shows paints nothing. The slices nothing draws (input, notices, lifecycle) ask for none.
 */

import { type TUI, watchSelection } from "@octocodeai/octocode-tui";
import type { UiState, UiStore } from "./store.ts";

const selectSlot = ({ overlay }: UiState) => overlay.slot;

/** Starts following the store; returns the function that stops it. */
export function bindRender(store: UiStore, ui: Pick<TUI, "requestRender">): () => void {
	return watchSelection(store, selectSlot, () => ui.requestRender());
}
