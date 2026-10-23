import { getKeybindings } from "../../keybindings.ts";
import { decodePrintableKey, matchesKey } from "../../keys.ts";
import {
	addNewLine,
	handleBackspace,
	handleForwardDelete,
	handlePaste,
	insertCharacter,
	shouldSubmitOnBackslashEnter,
	submitValue,
} from "./editing.ts";
import { isOnFirstVisualLine, isOnLastVisualLine, navigateHistory } from "./history.ts";
import {
	deleteToEndOfLine,
	deleteToStartOfLine,
	deleteWordBackwards,
	deleteWordForward,
	yank,
	yankPop,
} from "./kill-yank.ts";
import type { EditorModel } from "./model.ts";
import {
	jumpToChar,
	moveCursor,
	moveToLineEnd,
	moveToLineStart,
	moveWordBackwards,
	moveWordForwards,
	pageScroll,
} from "./movement.ts";

export function handleEditorInput(editor: EditorModel, data: string): void {
	const kb = getKeybindings();

	// Handle character jump mode (awaiting next character to jump to)
	if (editor.jumpMode !== null) {
		// Cancel if the hotkey is pressed again
		if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) {
			editor.jumpMode = null;
			return;
		}

		const printable = decodePrintableKey(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
		if (printable !== undefined) {
			// Printable character - perform the jump
			const direction = editor.jumpMode;
			editor.jumpMode = null;
			jumpToChar(editor, printable, direction);
			return;
		}

		// Control character - cancel and fall through to normal handling
		editor.jumpMode = null;
	}

	// Handle bracketed paste mode
	if (data.includes("\x1b[200~")) {
		editor.isInPaste = true;
		editor.pasteBuffer = "";
		data = data.replace("\x1b[200~", "");
	}

	if (editor.isInPaste) {
		editor.pasteBuffer += data;
		const endIndex = editor.pasteBuffer.indexOf("\x1b[201~");
		if (endIndex !== -1) {
			const pasteContent = editor.pasteBuffer.substring(0, endIndex);
			if (pasteContent.length > 0) {
				handlePaste(editor, pasteContent);
			}
			editor.isInPaste = false;
			const remaining = editor.pasteBuffer.substring(endIndex + 6);
			editor.pasteBuffer = "";
			if (remaining.length > 0) {
				editor.host.handleInput(remaining);
			}
			return;
		}
		return;
	}

	// Ctrl+C - let parent handle (exit/clear)
	if (kb.matches(data, "tui.input.copy")) {
		return;
	}

	// Undo
	if (kb.matches(data, "tui.editor.undo")) {
		editor.undo();
		return;
	}

	// Handle autocomplete mode
	if (editor.autocomplete.autocompleteState && editor.autocomplete.autocompleteList) {
		if (kb.matches(data, "tui.select.cancel")) {
			editor.autocomplete.cancelAutocomplete();
			return;
		}

		if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			editor.autocomplete.autocompleteList.handleInput(data);
			return;
		}

		if (kb.matches(data, "tui.input.tab")) {
			const selected = editor.autocomplete.autocompleteList.getSelectedItem();
			if (selected && editor.autocomplete.autocompleteProvider) {
				editor.pushUndoSnapshot();
				editor.lastAction = null;
				const result = editor.autocomplete.autocompleteProvider.applyCompletion(
					editor.state.lines,
					editor.state.cursorLine,
					editor.state.cursorCol,
					selected,
					editor.autocomplete.autocompletePrefix,
				);
				editor.state.lines = result.lines;
				editor.state.cursorLine = result.cursorLine;
				editor.setCursorCol(result.cursorCol);
				editor.autocomplete.cancelAutocomplete();
				editor.notifyChange();
				editor.autocomplete.continueCommandCompletion();
			}
			return;
		}

		if (kb.matches(data, "tui.select.confirm")) {
			const selected = editor.autocomplete.autocompleteList.getSelectedItem();
			if (selected && editor.autocomplete.autocompleteProvider) {
				editor.pushUndoSnapshot();
				editor.lastAction = null;
				const result = editor.autocomplete.autocompleteProvider.applyCompletion(
					editor.state.lines,
					editor.state.cursorLine,
					editor.state.cursorCol,
					selected,
					editor.autocomplete.autocompletePrefix,
				);
				editor.state.lines = result.lines;
				editor.state.cursorLine = result.cursorLine;
				editor.setCursorCol(result.cursorCol);

				if (editor.autocomplete.autocompletePrefix.startsWith("/")) {
					editor.autocomplete.cancelAutocomplete();
					// Fall through to submit
				} else {
					editor.autocomplete.cancelAutocomplete();
					editor.notifyChange();
					return;
				}
			}
		}
	}

	// Tab - trigger completion
	if (kb.matches(data, "tui.input.tab") && !editor.autocomplete.autocompleteState) {
		editor.autocomplete.handleTabCompletion();
		return;
	}

	// Deletion actions
	if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
		deleteToEndOfLine(editor);
		return;
	}
	if (kb.matches(data, "tui.editor.deleteToLineStart")) {
		deleteToStartOfLine(editor);
		return;
	}
	if (kb.matches(data, "tui.editor.deleteWordBackward")) {
		deleteWordBackwards(editor);
		return;
	}
	if (kb.matches(data, "tui.editor.deleteWordForward")) {
		deleteWordForward(editor);
		return;
	}
	if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
		handleBackspace(editor);
		return;
	}
	if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
		handleForwardDelete(editor);
		return;
	}

	// Kill ring actions
	if (kb.matches(data, "tui.editor.yank")) {
		yank(editor);
		return;
	}
	if (kb.matches(data, "tui.editor.yankPop")) {
		yankPop(editor);
		return;
	}

	// Dedicated history actions always browse entries instead of moving the cursor.
	if (kb.matches(data, "tui.editor.historyPrevious")) {
		editor.autocomplete.cancelAutocomplete();
		navigateHistory(editor, -1);
		return;
	}
	if (kb.matches(data, "tui.editor.historyNext")) {
		editor.autocomplete.cancelAutocomplete();
		navigateHistory(editor, 1);
		return;
	}

	// Cursor movement actions
	if (kb.matches(data, "tui.editor.cursorLineStart")) {
		moveToLineStart(editor);
		return;
	}
	if (kb.matches(data, "tui.editor.cursorLineEnd")) {
		moveToLineEnd(editor);
		return;
	}
	if (kb.matches(data, "tui.editor.cursorWordLeft")) {
		moveWordBackwards(editor);
		return;
	}
	if (kb.matches(data, "tui.editor.cursorWordRight")) {
		moveWordForwards(editor);
		return;
	}

	// New line
	if (
		kb.matches(data, "tui.input.newLine") ||
		(data.charCodeAt(0) === 10 && data.length > 1) ||
		data === "\x1b\r" ||
		data === "\x1b[13;2~" ||
		(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
		(data === "\n" && data.length === 1)
	) {
		if (shouldSubmitOnBackslashEnter(editor, data, kb)) {
			handleBackspace(editor);
			submitValue(editor);
			return;
		}
		addNewLine(editor);
		return;
	}

	// Submit (Enter)
	if (kb.matches(data, "tui.input.submit")) {
		if (editor.host.isSubmitDisabled()) return;

		// Workaround for terminals without Shift+Enter support:
		// If char before cursor is \, delete it and insert newline instead of submitting.
		const currentLine = editor.state.lines[editor.state.cursorLine] || "";
		if (editor.state.cursorCol > 0 && currentLine[editor.state.cursorCol - 1] === "\\") {
			handleBackspace(editor);
			addNewLine(editor);
			return;
		}

		submitValue(editor);
		return;
	}

	// Arrow key navigation (with history support)
	if (kb.matches(data, "tui.editor.cursorUp")) {
		if (
			isOnFirstVisualLine(editor) &&
			(editor.isEditorEmpty() || editor.historyIndex > -1 || editor.state.cursorCol === 0)
		) {
			navigateHistory(editor, -1);
		} else if (isOnFirstVisualLine(editor)) {
			// Already at top - jump to start of line
			moveToLineStart(editor);
		} else {
			moveCursor(editor, -1, 0);
		}
		return;
	}
	if (kb.matches(data, "tui.editor.cursorDown")) {
		if (editor.historyIndex > -1 && isOnLastVisualLine(editor)) {
			navigateHistory(editor, 1);
		} else if (isOnLastVisualLine(editor)) {
			// Already at bottom - jump to end of line
			moveToLineEnd(editor);
		} else {
			moveCursor(editor, 1, 0);
		}
		return;
	}
	if (kb.matches(data, "tui.editor.cursorRight")) {
		moveCursor(editor, 0, 1);
		return;
	}
	if (kb.matches(data, "tui.editor.cursorLeft")) {
		moveCursor(editor, 0, -1);
		return;
	}

	// Page up/down - scroll by page and move cursor
	if (kb.matches(data, "tui.editor.pageUp")) {
		pageScroll(editor, -1);
		return;
	}
	if (kb.matches(data, "tui.editor.pageDown")) {
		pageScroll(editor, 1);
		return;
	}

	// Character jump mode triggers
	if (kb.matches(data, "tui.editor.jumpForward")) {
		editor.jumpMode = "forward";
		return;
	}
	if (kb.matches(data, "tui.editor.jumpBackward")) {
		editor.jumpMode = "backward";
		return;
	}

	// Shift+Space - insert regular space
	if (matchesKey(data, "shift+space")) {
		insertCharacter(editor, " ");
		return;
	}

	const printable = decodePrintableKey(data);
	if (printable !== undefined) {
		insertCharacter(editor, printable);
		return;
	}

	// Regular characters
	if (data.charCodeAt(0) >= 32) {
		insertCharacter(editor, data);
	}
}
