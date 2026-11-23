/**
 * A short note the prompt's bottom rule shows for a moment (`ctrl+c again to exit`): the place the eye already is,
 * kept out of the transcript and the footer. One note at a time; a newer one replaces it. The prompt's decoration
 * (`ui/editor.ts`) draws it and repaints when it comes and goes.
 */

interface Note {
	text: string;
	timer: ReturnType<typeof setTimeout>;
}

let current: Note | undefined;
const listeners = new Set<() => void>();

const changed = () => {
	for (const listener of listeners) listener();
};

/** Shows `text` in the prompt's bottom rule for `ms`. */
export function showPromptNote(text: string, ms: number): void {
	if (current) clearTimeout(current.timer);
	const note: Note = {
		text,
		timer: setTimeout(() => {
			if (current !== note) return;
			current = undefined;
			changed();
		}, ms),
	};
	// The note never keeps the process alive: an exit within the window must not wait for it.
	note.timer.unref?.();
	current = note;
	changed();
}

/** Removes the note now (the second press acted on it); the next frame draws the plain rule. */
export function clearPromptNote(): void {
	if (current) clearTimeout(current.timer);
	current = undefined;
}

/** The note in force, if any. */
export const promptNote = (): string | undefined => current?.text;

/** Calls `listener` when a note comes or goes; returns what stops it. */
export function onPromptNote(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
