/**
 * Asks for a frame after every change to a slice the terminal draws. Writers only dispatch actions, which already skip
 * a write that changes nothing, so a frame is requested once per real change; the renderer coalesces those made in one
 * tick. The slices nothing draws (input, notices, status, lifecycle) ask for none.
 */

import { shallowEqual, type TUI, watchSelection } from "@octocodeai/octocode-tui";
import type { UiState, UiStore } from "./store.ts";

/** The drawn slices; each is replaced on change, so comparing them by identity sees every real change. */
const drawnSlices = ({ view, queue, editor, overlay }: UiState) => [view, queue, editor, overlay];

/** Starts following the store; returns the function that stops it. */
export function bindRender(store: UiStore, ui: Pick<TUI, "requestRender">): () => void {
	return watchSelection(store, drawnSlices, () => ui.requestRender(), shallowEqual);
}
