/**
 * Asks for a frame after every change to the store. Writers only dispatch actions, which already skip a write that
 * changes nothing, so a frame is requested once per real change; the renderer coalesces those made in one tick.
 */

import type { TUI } from "@octocodeai/octocode-tui";
import type { UiStore } from "./store.ts";

/** Starts following the store; returns the function that stops it. */
export function bindRender(store: UiStore, ui: Pick<TUI, "requestRender">): () => void {
	return store.subscribe(() => ui.requestRender());
}
