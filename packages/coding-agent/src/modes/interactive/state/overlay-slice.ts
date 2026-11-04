/**
 * Overlay slice of the interactive UI store: which selector, dialog or custom component holds the editor slot.
 * The slot is identified by a token; the component and its dispose stay with the code that opened it, because a
 * store must not hold component objects.
 */

import type { StoreApi } from "zustand/vanilla";

export interface OverlaySlice {
	/** Identity of whatever currently replaces the editor; `undefined` when the editor is shown. */
	slot: object | undefined;
}

export interface OverlayActions {
	/** Marks `token` as the holder of the editor slot. */
	takeSlot(token: object): void;
	/** Frees the slot, but only while `token` still holds it. Returns whether it did. */
	releaseSlot(token: object): boolean;
	/** Frees the slot whoever holds it. */
	clearSlot(): void;
}

export interface OverlayState {
	overlay: OverlaySlice;
}

type Get = StoreApi<OverlayState & OverlayActions>["getState"];
type Set = StoreApi<OverlayState & OverlayActions>["setState"];

export const initialOverlaySlice = (init: Partial<OverlaySlice> = {}): OverlaySlice => ({ slot: undefined, ...init });

export function createOverlayActions(set: Set, get: Get): OverlayActions {
	const setSlot = (slot: object | undefined) => {
		if (slot === get().overlay.slot) return;
		set({ overlay: { slot } });
	};
	return {
		takeSlot: setSlot,
		releaseSlot(token) {
			if (get().overlay.slot !== token) return false;
			setSlot(undefined);
			return true;
		},
		clearSlot: () => setSlot(undefined),
	};
}
