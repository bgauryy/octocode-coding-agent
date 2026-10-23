import type { EditorModel } from "./model.ts";
import { moveWordBackwards, moveWordForwards } from "./movement.ts";

export function deleteToStartOfLine(editor: EditorModel): void {
	editor.exitHistoryBrowsing();

	const currentLine = editor.state.lines[editor.state.cursorLine] || "";

	if (editor.state.cursorCol > 0) {
		editor.pushUndoSnapshot();

		// Calculate text to be deleted and save to kill ring (backward deletion = prepend)
		const deletedText = currentLine.slice(0, editor.state.cursorCol);
		editor.killRing.push(deletedText, { prepend: true, accumulate: editor.lastAction === "kill" });
		editor.lastAction = "kill";

		// Delete from start of line up to cursor
		editor.state.lines[editor.state.cursorLine] = currentLine.slice(editor.state.cursorCol);
		editor.setCursorCol(0);
	} else if (editor.state.cursorLine > 0) {
		editor.pushUndoSnapshot();

		// At start of line - merge with previous line, treating newline as deleted text
		editor.killRing.push("\n", { prepend: true, accumulate: editor.lastAction === "kill" });
		editor.lastAction = "kill";

		const previousLine = editor.state.lines[editor.state.cursorLine - 1] || "";
		editor.state.lines[editor.state.cursorLine - 1] = previousLine + currentLine;
		editor.state.lines.splice(editor.state.cursorLine, 1);
		editor.state.cursorLine--;
		editor.setCursorCol(previousLine.length);
	}

	editor.notifyChange();
}

export function deleteToEndOfLine(editor: EditorModel): void {
	editor.exitHistoryBrowsing();

	const currentLine = editor.state.lines[editor.state.cursorLine] || "";

	if (editor.state.cursorCol < currentLine.length) {
		editor.pushUndoSnapshot();

		// Calculate text to be deleted and save to kill ring (forward deletion = append)
		const deletedText = currentLine.slice(editor.state.cursorCol);
		editor.killRing.push(deletedText, { prepend: false, accumulate: editor.lastAction === "kill" });
		editor.lastAction = "kill";

		// Delete from cursor to end of line
		editor.state.lines[editor.state.cursorLine] = currentLine.slice(0, editor.state.cursorCol);
	} else if (editor.state.cursorLine < editor.state.lines.length - 1) {
		editor.pushUndoSnapshot();

		// At end of line - merge with next line, treating newline as deleted text
		editor.killRing.push("\n", { prepend: false, accumulate: editor.lastAction === "kill" });
		editor.lastAction = "kill";

		const nextLine = editor.state.lines[editor.state.cursorLine + 1] || "";
		editor.state.lines[editor.state.cursorLine] = currentLine + nextLine;
		editor.state.lines.splice(editor.state.cursorLine + 1, 1);
	}

	editor.notifyChange();
}

export function deleteWordBackwards(editor: EditorModel): void {
	editor.exitHistoryBrowsing();

	const currentLine = editor.state.lines[editor.state.cursorLine] || "";

	// If at start of line, behave like backspace at column 0 (merge with previous line)
	if (editor.state.cursorCol === 0) {
		if (editor.state.cursorLine > 0) {
			editor.pushUndoSnapshot();

			// Treat newline as deleted text (backward deletion = prepend)
			editor.killRing.push("\n", { prepend: true, accumulate: editor.lastAction === "kill" });
			editor.lastAction = "kill";

			const previousLine = editor.state.lines[editor.state.cursorLine - 1] || "";
			editor.state.lines[editor.state.cursorLine - 1] = previousLine + currentLine;
			editor.state.lines.splice(editor.state.cursorLine, 1);
			editor.state.cursorLine--;
			editor.setCursorCol(previousLine.length);
		}
	} else {
		editor.pushUndoSnapshot();

		// Save lastAction before cursor movement (moveWordBackwards resets it)
		const wasKill = editor.lastAction === "kill";

		const oldCursorCol = editor.state.cursorCol;
		moveWordBackwards(editor);
		const deleteFrom = editor.state.cursorCol;
		editor.setCursorCol(oldCursorCol);

		const deletedText = currentLine.slice(deleteFrom, editor.state.cursorCol);
		editor.killRing.push(deletedText, { prepend: true, accumulate: wasKill });
		editor.lastAction = "kill";

		editor.state.lines[editor.state.cursorLine] =
			currentLine.slice(0, deleteFrom) + currentLine.slice(editor.state.cursorCol);
		editor.setCursorCol(deleteFrom);
	}

	editor.notifyChange();
}

export function deleteWordForward(editor: EditorModel): void {
	editor.exitHistoryBrowsing();

	const currentLine = editor.state.lines[editor.state.cursorLine] || "";

	// If at end of line, merge with next line (delete the newline)
	if (editor.state.cursorCol >= currentLine.length) {
		if (editor.state.cursorLine < editor.state.lines.length - 1) {
			editor.pushUndoSnapshot();

			// Treat newline as deleted text (forward deletion = append)
			editor.killRing.push("\n", { prepend: false, accumulate: editor.lastAction === "kill" });
			editor.lastAction = "kill";

			const nextLine = editor.state.lines[editor.state.cursorLine + 1] || "";
			editor.state.lines[editor.state.cursorLine] = currentLine + nextLine;
			editor.state.lines.splice(editor.state.cursorLine + 1, 1);
		}
	} else {
		editor.pushUndoSnapshot();

		// Save lastAction before cursor movement (moveWordForwards resets it)
		const wasKill = editor.lastAction === "kill";

		const oldCursorCol = editor.state.cursorCol;
		moveWordForwards(editor);
		const deleteTo = editor.state.cursorCol;
		editor.setCursorCol(oldCursorCol);

		const deletedText = currentLine.slice(editor.state.cursorCol, deleteTo);
		editor.killRing.push(deletedText, { prepend: false, accumulate: wasKill });
		editor.lastAction = "kill";

		editor.state.lines[editor.state.cursorLine] =
			currentLine.slice(0, editor.state.cursorCol) + currentLine.slice(deleteTo);
	}

	editor.notifyChange();
}

/**
 * Yank (paste) the most recent kill ring entry at cursor position.
 */
export function yank(editor: EditorModel): void {
	if (editor.killRing.length === 0) return;

	editor.pushUndoSnapshot();

	const text = editor.killRing.peek()!;
	insertYankedText(editor, text);

	editor.lastAction = "yank";
}

/**
 * Cycle through kill ring (only works immediately after yank or yank-pop).
 * Replaces the last yanked text with the previous entry in the ring.
 */
export function yankPop(editor: EditorModel): void {
	// Only works if we just yanked and have more than one entry
	if (editor.lastAction !== "yank" || editor.killRing.length <= 1) return;

	editor.pushUndoSnapshot();

	// Delete the previously yanked text (still at end of ring before rotation)
	deleteYankedText(editor);

	// Rotate the ring: move end to front
	editor.killRing.rotate();

	// Insert the new most recent entry (now at end after rotation)
	const text = editor.killRing.peek()!;
	insertYankedText(editor, text);

	editor.lastAction = "yank";
}

/**
 * Insert text at cursor position (used by yank operations).
 */
export function insertYankedText(editor: EditorModel, text: string): void {
	editor.exitHistoryBrowsing();
	const lines = text.split("\n");

	if (lines.length === 1) {
		// Single line - insert at cursor
		const currentLine = editor.state.lines[editor.state.cursorLine] || "";
		const before = currentLine.slice(0, editor.state.cursorCol);
		const after = currentLine.slice(editor.state.cursorCol);
		editor.state.lines[editor.state.cursorLine] = before + text + after;
		editor.setCursorCol(editor.state.cursorCol + text.length);
	} else {
		// Multi-line insert
		const currentLine = editor.state.lines[editor.state.cursorLine] || "";
		const before = currentLine.slice(0, editor.state.cursorCol);
		const after = currentLine.slice(editor.state.cursorCol);

		// First line merges with text before cursor
		editor.state.lines[editor.state.cursorLine] = before + (lines[0] || "");

		// Insert middle lines
		for (let i = 1; i < lines.length - 1; i++) {
			editor.state.lines.splice(editor.state.cursorLine + i, 0, lines[i] || "");
		}

		// Last line merges with text after cursor
		const lastLineIndex = editor.state.cursorLine + lines.length - 1;
		editor.state.lines.splice(lastLineIndex, 0, (lines[lines.length - 1] || "") + after);

		// Update cursor position
		editor.state.cursorLine = lastLineIndex;
		editor.setCursorCol((lines[lines.length - 1] || "").length);
	}

	editor.notifyChange();
}

/**
 * Delete the previously yanked text (used by yank-pop).
 * The yanked text is derived from killRing[end] since it hasn't been rotated yet.
 */
export function deleteYankedText(editor: EditorModel): void {
	const yankedText = editor.killRing.peek();
	if (!yankedText) return;

	const yankLines = yankedText.split("\n");

	if (yankLines.length === 1) {
		// Single line - delete backward from cursor
		const currentLine = editor.state.lines[editor.state.cursorLine] || "";
		const deleteLen = yankedText.length;
		const before = currentLine.slice(0, editor.state.cursorCol - deleteLen);
		const after = currentLine.slice(editor.state.cursorCol);
		editor.state.lines[editor.state.cursorLine] = before + after;
		editor.setCursorCol(editor.state.cursorCol - deleteLen);
	} else {
		// Multi-line delete - cursor is at end of last yanked line
		const startLine = editor.state.cursorLine - (yankLines.length - 1);
		const startCol = (editor.state.lines[startLine] || "").length - (yankLines[0] || "").length;

		// Get text after cursor on current line
		const afterCursor = (editor.state.lines[editor.state.cursorLine] || "").slice(editor.state.cursorCol);

		// Get text before yank start position
		const beforeYank = (editor.state.lines[startLine] || "").slice(0, startCol);

		// Remove all lines from startLine to cursorLine and replace with merged line
		editor.state.lines.splice(startLine, yankLines.length, beforeYank + afterCursor);

		// Update cursor
		editor.state.cursorLine = startLine;
		editor.setCursorCol(startCol);
	}

	editor.notifyChange();
}
