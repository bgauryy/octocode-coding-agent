import type { EditorModel } from "./model.ts";

/**
 * Add a prompt to history for up/down arrow navigation.
 * Called after successful submission.
 */
export function addToHistory(editor: EditorModel, text: string): void {
	const trimmed = text.trim();
	if (!trimmed) return;
	// Don't add consecutive duplicates
	if (editor.history.length > 0 && editor.history[0] === trimmed) return;
	editor.history.unshift(trimmed);
	// Limit history size
	if (editor.history.length > 100) {
		editor.history.pop();
	}
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

export function navigateHistory(editor: EditorModel, direction: 1 | -1): void {
	editor.lastAction = null;
	if (editor.history.length === 0) return;

	const newIndex = editor.historyIndex - direction; // Up(-1) increases index, Down(1) decreases
	if (newIndex < -1 || newIndex >= editor.history.length) return;

	// Capture state when first entering history browsing mode
	if (editor.historyIndex === -1 && newIndex >= 0) {
		editor.pushUndoSnapshot();
		editor.historyDraft = structuredClone(editor.state);
	}

	editor.historyIndex = newIndex;

	if (editor.historyIndex === -1) {
		const draft = editor.historyDraft;
		editor.historyDraft = null;
		if (draft) {
			editor.state = draft;
			editor.preferredVisualCol = null;
			editor.snappedFromCursorCol = null;
			editor.scrollOffset = 0;
			editor.notifyChange();
		} else {
			editor.setTextInternal("");
		}
	} else {
		editor.setTextInternal(editor.history[editor.historyIndex] || "", direction === -1 ? "start" : "end");
	}
}
