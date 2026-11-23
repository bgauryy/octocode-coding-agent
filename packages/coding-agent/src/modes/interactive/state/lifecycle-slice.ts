/**
 * Lifecycle slice of the interactive UI store: whether the terminal UI is mounted, whether the host is shutting down,
 * and whether a feature asked for a shutdown that waits for the run to settle. Nothing draws it, so `bindRender` asks
 * for no frame when it changes.
 */

import type { StoreApi } from "zustand/vanilla";

export interface LifecycleSlice {
	/** `init` mounted the terminal UI; a permanent stop unmounts it. */
	initialized: boolean;
	/** A shutdown, crash or dead terminal is ending the host; nothing starts another. */
	shuttingDown: boolean;
	/** A feature asked to shut down (`ctx.shutdown()`); the host does once the run settles. */
	shutdownRequested: boolean;
}

export interface LifecycleActions {
	setInitialized(initialized: boolean): void;
	/** Marks the host shutting down; true only for the first caller, which then runs the shutdown. */
	beginShutdown(): boolean;
	requestShutdown(): void;
}

export interface LifecycleState {
	lifecycle: LifecycleSlice;
}

type Get = StoreApi<LifecycleState & LifecycleActions>["getState"];
type Set = StoreApi<LifecycleState & LifecycleActions>["setState"];

export const initialLifecycleSlice = (init: Partial<LifecycleSlice> = {}): LifecycleSlice => ({
	initialized: false,
	shuttingDown: false,
	shutdownRequested: false,
	...init,
});

export const selectInitialized = (state: LifecycleState): boolean => state.lifecycle.initialized;
export const selectShuttingDown = (state: LifecycleState): boolean => state.lifecycle.shuttingDown;
export const selectShutdownRequested = (state: LifecycleState): boolean => state.lifecycle.shutdownRequested;

export function createLifecycleActions(set: Set, get: Get): LifecycleActions {
	const patch = (next: Partial<LifecycleSlice>) => set((state) => ({ lifecycle: { ...state.lifecycle, ...next } }));
	return {
		setInitialized(initialized) {
			if (initialized === get().lifecycle.initialized) return;
			patch({ initialized });
		},
		beginShutdown() {
			if (get().lifecycle.shuttingDown) return false;
			patch({ shuttingDown: true });
			return true;
		},
		requestShutdown() {
			if (get().lifecycle.shutdownRequested) return;
			patch({ shutdownRequested: true });
		},
	};
}
