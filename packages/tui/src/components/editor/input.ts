import { getKeybindings } from "../../keybindings.ts";
import { matchesKey } from "../../keys/match.ts";
import { decodePrintableKey } from "../../keys/parse.ts";
import {
	addNewLine,
	handleBackspace,
	handleForwardDelete,
	handlePaste,
	insertCharacter,
	shouldSubmitOnBackslashEnter,
	submitValue,
} from "./editing.ts";
import { acceptGhost } from "./ghost.ts";
import { atHistoryRecall, isOnFirstVisualLine, isOnLastVisualLine, navigateHistory } from "./history.ts";
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

	const paste = editor.bracketedPaste.take(data);
	if (paste) {
		// Until the end marker arrives there is no content; input after it is handled as ordinary input.
		if (paste.content) handlePaste(editor, paste.content);
		if (paste.remaining) editor.host.handleInput(paste.remaining);
		return;
	}

	// Ctrl+C - let parent handle (exit/clear)
	if (kb.matches(data, "tui.input.copy")) {
		return;
	}

	if (kb.matches(data, "tui.editor.undo")) {
		editor.undo();
		return;
	}

	// Clears an Esc dismissal once the cursor has left its token (before this key can reopen the list).
	editor.autocomplete.isDismissed();

	// Esc while a request is pending (no list yet) cancels the request and keeps the text.
	if (kb.matches(data, "tui.select.cancel") && editor.autocomplete.hasPendingRequest()) {
		editor.autocomplete.dismissAutocomplete();
		return;
	}

	if (editor.autocomplete.autocompleteState && editor.autocomplete.autocompleteList) {
		if (kb.matches(data, "tui.select.cancel")) {
			editor.autocomplete.dismissAutocomplete();
			return;
		}

		if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			editor.autocomplete.autocompleteList.handleInput(data);
			return;
		}
		if (matchesKey(data, "ctrl+p") || matchesKey(data, "ctrl+n")) {
			editor.autocomplete.autocompleteList.moveSelection(matchesKey(data, "ctrl+p") ? -1 : 1);
			return;
		}

		// Right on a directory in an @ list drills into it.
		if (kb.matches(data, "tui.editor.cursorRight") && editor.autocomplete.autocompletePrefix.startsWith("@")) {
			const selected = editor.autocomplete.autocompleteList.getSelectedItem();
			if (selected && (selected.kind === "directory" || selected.label.endsWith("/"))) {
				editor.autocomplete.acceptCompletion(selected);
				return;
			}
		}

		if (kb.matches(data, "tui.input.tab")) {
			const selected = editor.autocomplete.autocompleteList.getSelectedItem();
			if (selected) editor.autocomplete.acceptCompletion(selected);
			return;
		}

		if (kb.matches(data, "tui.select.confirm")) {
			const selected = editor.autocomplete.autocompleteList.getSelectedItem();
			// An @ list that is still indexing has nothing to insert yet; Enter must not send the half-typed prompt.
			if (!selected && editor.autocomplete.autocompleteIndexing) return;
			const { cursorLine, cursorCol, lines } = editor.state;
			const prefix = editor.autocomplete.autocompletePrefix;
			const atInputStart = cursorLine === 0 && (lines[0] || "").slice(0, cursorCol - prefix.length).trim() === "";
			const beforeCursor = (lines[cursorLine] || "").slice(0, cursorCol);
			const midInputSkill = !atInputStart && editor.isInSkillMentionContext(beforeCursor);
			const typed = editor.getText();
			const commandArgument = cursorLine === 0 && editor.isInSlashCommandContext(beforeCursor);
			if (selected && editor.autocomplete.insertCompletion(selected, prefix)) {
				// A command (or its `/path` argument) runs; a skill named mid-input only inserts. An argument typed in
				// full (`/backlog tui`) runs too: a completion that changes nothing would only cost a second Enter.
				const exact = commandArgument && editor.getText().trimEnd() === typed.trimEnd();
				if ((prefix.startsWith("/") && !midInputSkill) || exact) {
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

	if (kb.matches(data, "tui.input.tab") && !editor.autocomplete.autocompleteState) {
		editor.autocomplete.handleTabCompletion();
		return;
	}

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

	if (kb.matches(data, "tui.editor.cursorLineStart")) {
		moveToLineStart(editor);
		return;
	}
	// Right or End at the end of the text accepts the ghost text; word-right accepts its next word.
	const accept = kb.matches(data, "tui.editor.cursorWordRight")
		? "word"
		: kb.matches(data, "tui.editor.cursorLineEnd") || kb.matches(data, "tui.editor.cursorRight")
			? "all"
			: undefined;
	if (accept && acceptGhost(editor, accept)) {
		editor.autocomplete.cancelAutocomplete();
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
			atHistoryRecall(editor) ||
			(isOnFirstVisualLine(editor) &&
				(editor.isEditorEmpty() || editor.historyIndex > -1 || editor.state.cursorCol === 0))
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
		if (atHistoryRecall(editor) || (editor.historyIndex > -1 && isOnLastVisualLine(editor))) {
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

	if (kb.matches(data, "tui.editor.jumpForward")) {
		editor.jumpMode = "forward";
		return;
	}
	if (kb.matches(data, "tui.editor.jumpBackward")) {
		editor.jumpMode = "backward";
		return;
	}

	if (matchesKey(data, "shift+space")) {
		insertCharacter(editor, " ");
		return;
	}

	const printable = decodePrintableKey(data);
	if (printable !== undefined) {
		insertCharacter(editor, printable);
		return;
	}

	if (data.charCodeAt(0) >= 32) {
		insertCharacter(editor, data);
	}
}
