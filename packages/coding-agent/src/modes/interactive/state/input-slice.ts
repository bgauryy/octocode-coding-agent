/**
 * Input slice of the interactive UI store: the timing of the Esc and Ctrl+C gestures, the prompts submitted that the
 * main loop has not read yet, and the `fd` binary file completion searches with. Nothing draws it, so no binder asks for a frame when it changes; the key
 * handlers change it only through these actions, which own the double-Esc and burst windows.
 */

import type { StoreApi } from "zustand/vanilla";

/**
 * How long after an Esc that aborted or interrupted something further Esc presses are ignored by the double-Esc action.
 * 500 ms is the double-Esc window itself: a press that close to the last one belongs to the same burst, whoever mashes
 * Esc to stop a run does not mean "open the tree", and each ignored press extends the quiet time, so one long burst
 * (100 ms apart in the audit) never ends in a tree. Only a pause of this length makes the next two Esc presses a gesture.
 */
const ESCAPE_BURST_MS = 500;

export interface InputSlice {
	/** When the first Esc of a possible double-Esc was pressed (ms epoch); 0 when the next press starts over. */
	escapeAt: number;
	/** Esc presses before this time (ms epoch) are part of the burst that aborted something and never open the tree. */
	escapeQuietUntil: number;
	/** Esc aborted the run that is processing the submitted prompt (reset at each submit). */
	escapeAbortedRun: boolean;
	/** When Ctrl+C last cleared the prompt (ms epoch). */
	interruptAt: number;
	/** Prompts submitted that the main loop has not read yet, oldest first; replaced (never mutated) on each change. */
	submitted: readonly string[];
	/** The `fd` binary startup ensured, for `@` file completion; undefined until then, or when none could be had. */
	fdPath: string | undefined;
}

export interface InputActions {
	/** Esc stopped something at `now` (the run itself when `abortedRun`): presses in the burst after it are no gesture. */
	quietEscapes(now: number, abortedRun?: boolean): void;
	/** Whether an Esc at `now` falls in such a burst; when it does, it extends the burst and starts no double-Esc. */
	escapeInBurst(now: number): boolean;
	/** A lone Esc at `now`: true when it completes a double-Esc (the next press starts over), otherwise it starts one. */
	doubleEscape(now: number): boolean;
	/** A prompt is submitted: no Esc has aborted its run yet. */
	clearEscapeAbort(): void;
	/** Ctrl+C cleared the prompt at `now`. */
	noteInterrupt(now: number): void;
	/** Hands a submitted prompt to the main loop (`getUserInput`), after any it has not read yet. */
	submitInput(text: string): void;
	/** Removes and returns the oldest prompt the main loop has not read, if any. */
	takeInput(): string | undefined;
	setFdPath(path: string | undefined): void;
}

export interface InputState {
	input: InputSlice;
}

type Get = StoreApi<InputState & InputActions>["getState"];
type Set = StoreApi<InputState & InputActions>["setState"];

export const initialInputSlice = (init: Partial<InputSlice> = {}): InputSlice => ({
	escapeAt: 0,
	escapeQuietUntil: 0,
	escapeAbortedRun: false,
	interruptAt: 0,
	submitted: [],
	fdPath: undefined,
	...init,
});

export const selectEscapeAbortedRun = (state: InputState): boolean => state.input.escapeAbortedRun;
export const selectInterruptAt = (state: InputState): number => state.input.interruptAt;
export const selectFdPath = (state: InputState): string | undefined => state.input.fdPath;
export const selectSubmittedInputs = (state: InputState): readonly string[] => state.input.submitted;

export function createInputActions(set: Set, get: Get): InputActions {
	const patch = (next: Partial<InputSlice>) => {
		const input = get().input;
		if ((Object.keys(next) as (keyof InputSlice)[]).every((key) => input[key] === next[key])) return;
		set({ input: { ...input, ...next } });
	};
	return {
		quietEscapes(now, abortedRun) {
			patch({ escapeQuietUntil: now + ESCAPE_BURST_MS, ...(abortedRun ? { escapeAbortedRun: true } : {}) });
		},
		escapeInBurst(now) {
			if (now >= get().input.escapeQuietUntil) return false;
			patch({ escapeQuietUntil: now + ESCAPE_BURST_MS, escapeAt: 0 });
			return true;
		},
		doubleEscape(now) {
			const completes = now - get().input.escapeAt < ESCAPE_BURST_MS;
			patch({ escapeAt: completes ? 0 : now });
			return completes;
		},
		clearEscapeAbort() {
			patch({ escapeAbortedRun: false });
		},
		noteInterrupt(now) {
			patch({ interruptAt: now });
		},
		submitInput(text) {
			set((state) => ({ input: { ...state.input, submitted: [...state.input.submitted, text] } }));
		},
		takeInput() {
			const [oldest, ...rest] = get().input.submitted;
			if (oldest === undefined) return undefined;
			set((state) => ({ input: { ...state.input, submitted: rest } }));
			return oldest;
		},
		setFdPath(path) {
			patch({ fdPath: path });
		},
	};
}
