import { largePasteMarker } from "./editing.ts";
import type { EditorModel } from "./model.ts";
import { expandPasteMarkers, PASTE_MARKER_REGEX } from "./segmentation.ts";
import type { HistoryEntry } from "./types.ts";

/** Up in an empty editor recalls the last few prompts of the session. */
const MAX_HISTORY = 5;

/** The full text an entry submits. */
const expandedEntry = (entry: HistoryEntry): string =>
	entry.pastes ? expandPasteMarkers(entry.text, entry.pastes).trim() : entry.text;

/**
 * The entry for a submitted `text`: the submitted draft with its paste markers collapsed when `text` is what it sent.
 * Text the editor did not just send (a prompt from a resumed session) shows as one paste marker when it is as large as
 * a paste that gets one.
 */
function historyEntry(editor: EditorModel, text: string): HistoryEntry {
	const draft = editor.submitted;
	if (draft?.text === text) {
		if (draft.pastes.size === 0) return { text };
		const collapsed = draft.state.lines.join("\n").trim();
		const pastes = new Map<number, string>();
		for (const match of collapsed.matchAll(PASTE_MARKER_REGEX)) {
			const id = Number(match[1]);
			const content = draft.pastes.get(id);
			if (content !== undefined) pastes.set(id, content);
		}
		// Fail open: an entry whose markers do not expand to the sent text keeps the text.
		const entry = { text: collapsed, pastes };
		if (pastes.size > 0 && expandedEntry(entry) === text) return entry;
		return { text };
	}
	const marker = largePasteMarker(1, text);
	return marker ? { text: marker, pastes: new Map([[1, text]]) } : { text };
}

/**
 * Add a prompt to history for up/down arrow navigation.
 * Called after successful submission.
 */
export function addToHistory(editor: EditorModel, text: string): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	const head = editor.history[0];
	if (head && (head.pastes ? expandedEntry(head) : head.text) === trimmed) return;
	editor.history.unshift(historyEntry(editor, trimmed));
	if (editor.history.length > MAX_HISTORY) {
		editor.history.pop();
	}
}

/** Forget every prompt and stop browsing: a different session starts its own history. */
export function clearHistory(editor: EditorModel): void {
	editor.history.length = 0;
	editor.historyIndex = -1;
	editor.historyDraft = null;
}

export function isOnFirstVisualLine(editor: EditorModel): boolean {
	const visualLines = editor.buildVisualLineMap(editor.lastWidth);
	const currentVisualLine = editor.findCurrentVisualLine(visualLines);
	return currentVisualLine === 0;
}

export function isOnLastVisualLine(editor: EditorModel): boolean {
	const visualLines = editor.buildVisualLineMap(editor.lastWidth);
	const currentVisualLine = editor.findCurrentVisualLine(visualLines);
	return currentVisualLine === visualLines.length - 1;
}

/** Show `entry` with its own paste registry, so its markers expand and a new paste gets the next id. */
function showEntry(editor: EditorModel, entry: HistoryEntry, cursorPlacement: "start" | "end"): void {
	editor.pastes = new Map(entry.pastes);
	editor.pasteCounter = entry.pastes ? Math.max(0, ...entry.pastes.keys()) : 0;
	editor.setTextInternal(entry.text, cursorPlacement);
}

export function navigateHistory(editor: EditorModel, direction: 1 | -1): void {
	editor.lastAction = null;
	if (editor.history.length === 0) return;

	const newIndex = editor.historyIndex - direction; // Up(-1) increases index, Down(1) decreases
	if (newIndex < -1 || newIndex >= editor.history.length) return;

	// Capture state when first entering history browsing mode
	if (editor.historyIndex === -1 && newIndex >= 0) {
		editor.pushUndoSnapshot();
		editor.historyDraft = {
			state: structuredClone(editor.state),
			pastes: new Map(editor.pastes),
			pasteCounter: editor.pasteCounter,
		};
	}

	editor.historyIndex = newIndex;

	if (editor.historyIndex === -1) {
		const draft = editor.historyDraft;
		editor.historyDraft = null;
		if (draft) {
			editor.state = draft.state;
			editor.pastes = draft.pastes;
			editor.pasteCounter = draft.pasteCounter;
			editor.preferredVisualCol = null;
			editor.snappedFromCursorCol = null;
			editor.scrollOffset = 0;
			editor.notifyChange();
		} else {
			showEntry(editor, { text: "" }, "end");
		}
	} else {
		showEntry(editor, editor.history[editor.historyIndex] ?? { text: "" }, direction === -1 ? "start" : "end");
	}
}
