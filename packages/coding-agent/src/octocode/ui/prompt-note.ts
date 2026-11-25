/**
 * A short note the prompt's bottom rule shows for a moment (`ctrl+c again to exit`): the place the eye already is,
 * kept out of the transcript and the footer. One note at a time; a newer one replaces it. The prompt's decoration
 * (`ui/editor.ts`) draws it and repaints when the shown text changes.
 */

import { createStore } from "zustand/vanilla";

interface PromptNoteState {
	/** The note in force, if any. */
	text: string | undefined;
}

/** The note the prompt shows: a state source the editor watches. */
export const promptNoteStore = createStore<PromptNoteState>(() => ({ text: undefined }));

let timer: ReturnType<typeof setTimeout> | undefined;

const setText = (text: string | undefined) => {
	if (promptNoteStore.getState().text !== text) promptNoteStore.setState({ text });
};

/** Shows `text` in the prompt's bottom rule for `ms`. */
export function showPromptNote(text: string, ms: number): void {
	if (timer) clearTimeout(timer);
	const own = setTimeout(() => {
		if (timer !== own) return;
		timer = undefined;
		setText(undefined);
	}, ms);
	// The note never keeps the process alive: an exit within the window must not wait for it.
	own.unref?.();
	timer = own;
	setText(text);
}

/** Removes the note now (the second press acted on it). */
export function clearPromptNote(): void {
	if (timer) clearTimeout(timer);
	timer = undefined;
	setText(undefined);
}

/** The note in force, if any. */
export const promptNote = (): string | undefined => promptNoteStore.getState().text;
