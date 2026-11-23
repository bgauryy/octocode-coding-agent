import { describe, expect, it, vi } from "vitest";
import { selectEscapeAbortedRun, selectInterruptAt } from "../src/modes/interactive/state/input-slice.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";

describe("input slice", () => {
	it("completes a double Esc within the window and starts over after it", () => {
		const input = createUiStore().getState();

		expect(input.doubleEscape(1_000)).toBe(false);
		expect(input.doubleEscape(1_400)).toBe(true);
		expect(input.doubleEscape(1_600)).toBe(false);
		expect(input.doubleEscape(2_200)).toBe(false);
	});

	it("keeps every press of a burst after an abort from opening the tree until a pause", () => {
		const store = createUiStore();
		const input = store.getState();

		input.quietEscapes(1_000, true);
		// Mashed 100 ms apart for longer than the window: each press extends the burst.
		for (const at of [1_100, 1_200, 1_300, 1_400, 1_500, 1_600, 1_700]) expect(input.escapeInBurst(at)).toBe(true);
		expect(input.escapeInBurst(2_300)).toBe(false);
		expect(input.doubleEscape(2_300)).toBe(false);
		expect(input.doubleEscape(2_500)).toBe(true);
		expect(selectEscapeAbortedRun(store.getState())).toBe(true);
	});

	it("starts a new double Esc with the first press after a burst", () => {
		const input = createUiStore().getState();

		expect(input.doubleEscape(1_000)).toBe(false);
		input.quietEscapes(1_100);
		expect(input.escapeInBurst(1_200)).toBe(true);
		expect(input.escapeInBurst(1_800)).toBe(false);
		expect(input.doubleEscape(1_800)).toBe(false);
	});

	it("resets the aborted-run flag at each submit and records Ctrl+C presses", () => {
		const store = createUiStore();
		const input = store.getState();

		input.quietEscapes(1_000);
		expect(selectEscapeAbortedRun(store.getState())).toBe(false);
		input.quietEscapes(1_000, true);
		input.clearEscapeAbort();
		expect(selectEscapeAbortedRun(store.getState())).toBe(false);

		input.noteInterrupt(5_000);
		expect(selectInterruptAt(store.getState())).toBe(5_000);
	});

	it("publishes nothing for a write that changes nothing", () => {
		const store = createUiStore();
		const listener = vi.fn();
		store.subscribe(listener);
		const input = store.getState();

		input.clearEscapeAbort();
		expect(input.escapeInBurst(1_000)).toBe(false);
		expect(listener).not.toHaveBeenCalled();

		input.noteInterrupt(5_000);
		input.noteInterrupt(5_000);
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
