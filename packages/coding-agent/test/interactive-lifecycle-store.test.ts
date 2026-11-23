import { describe, expect, it, vi } from "vitest";
import {
	selectInitialized,
	selectShutdownRequested,
	selectShuttingDown,
} from "../src/modes/interactive/state/lifecycle-slice.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";

describe("lifecycle slice", () => {
	it("lets only the first caller run the shutdown", () => {
		const store = createUiStore();

		expect(store.getState().beginShutdown()).toBe(true);
		expect(store.getState().beginShutdown()).toBe(false);
		expect(selectShuttingDown(store.getState())).toBe(true);
	});

	it("records the mount, its end and a feature's shutdown request, publishing only real changes", () => {
		const store = createUiStore();
		const listener = vi.fn();
		store.subscribe(listener);
		const lifecycle = store.getState();

		lifecycle.setInitialized(true);
		lifecycle.setInitialized(true);
		expect(selectInitialized(store.getState())).toBe(true);
		lifecycle.setInitialized(false);
		lifecycle.requestShutdown();
		lifecycle.requestShutdown();

		expect(selectInitialized(store.getState())).toBe(false);
		expect(selectShutdownRequested(store.getState())).toBe(true);
		expect(listener).toHaveBeenCalledTimes(3);
	});
});
