import type { getKeybindings } from "../../keybindings.ts";
import { decodePastedControlKeys } from "../../bracketed-paste.ts";
import { matchesKey } from "../../keys/match.ts";
import { cjkBreakRegex, isWhitespaceChar } from "../../utils/chars.ts";
import type { EditorModel } from "./model.ts";
import { PASTE_MARKER_REGEX, PASTE_MARKER_SINGLE } from "./segmentation.ts";

/**
 * Internal text insertion at cursor. Handles single and multi-line text.
 * Does not push undo snapshots or trigger autocomplete - caller is responsible.
 * Normalizes line endings and calls onChange once at the end.
 */
export function insertTextAtCursorInternal(editor: EditorModel, text: string): void {
	if (!text) return;

	const normalized = editor.normalizeText(text);
	const insertedLines = normalized.split("\n");

	const currentLine = editor.state.lines[editor.state.cursorLine] || "";
	const beforeCursor = currentLine.slice(0, editor.state.cursorCol);
	const afterCursor = currentLine.slice(editor.state.cursorCol);

	if (insertedLines.length === 1) {
		editor.state.lines[editor.state.cursorLine] = beforeCursor + normalized + afterCursor;
		editor.setCursorCol(editor.state.cursorCol + normalized.length);
	} else {
		editor.state.lines = [
			...editor.state.lines.slice(0, editor.state.cursorLine),

			// The first inserted line merged with text before cursor
			beforeCursor + insertedLines[0],

			...insertedLines.slice(1, -1),

			// The last inserted line with text after cursor
			insertedLines[insertedLines.length - 1] + afterCursor,

			...editor.state.lines.slice(editor.state.cursorLine + 1),
		];

		editor.state.cursorLine += insertedLines.length - 1;
		editor.setCursorCol((insertedLines[insertedLines.length - 1] || "").length);
	}

	editor.notifyChange();
}

export function insertCharacter(editor: EditorModel, char: string, skipUndoCoalescing?: boolean): void {
	editor.exitHistoryBrowsing();

	// Undo coalescing (fish-style):
	// - Consecutive word chars coalesce into one undo unit
	// - Space captures state before itself (so undo removes space+following word together)
	// - Each space is separately undoable
	// Skip coalescing when called from atomic operations (e.g., handlePaste)
	if (!skipUndoCoalescing) {
		if (isWhitespaceChar(char) || editor.lastAction !== "type-word") {
			editor.pushUndoSnapshot();
		}
		editor.lastAction = "type-word";
	}

	const line = editor.state.lines[editor.state.cursorLine] || "";

	const before = line.slice(0, editor.state.cursorCol);
	const after = line.slice(editor.state.cursorCol);

	editor.state.lines[editor.state.cursorLine] = before + char + after;
	editor.setCursorCol(editor.state.cursorCol + char.length);

	editor.notifyChange();

	// A new trigger character reopens a list the user closed with Esc.
	if (editor.autocomplete.autocompleteTriggerCharacters.includes(char)) editor.autocomplete.clearDismissal();

	// Check if we should trigger or update autocomplete
	if (!editor.autocomplete.autocompleteState) {
		// Auto-trigger for "/" at the start of the input (commands) or at any other token start (skills)
		if (char === "/" && (editor.isAtStartOfMessage() || editor.isAtSkillMentionStart())) {
			editor.autocomplete.tryTriggerAutocomplete();
		}
		// Auto-trigger for symbol-based completion like @, #, or provider triggers at token boundaries
		else if (editor.autocomplete.autocompleteTriggerCharacters.includes(char)) {
			const currentLine = editor.state.lines[editor.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, editor.state.cursorCol);
			if (editor.autocomplete.autocompleteTriggerPattern.test(textBeforeCursor)) {
				editor.autocomplete.tryTriggerAutocomplete();
			}
		}
		// Also auto-trigger when typing letters in a slash command or symbol completion context
		else if (/[a-zA-Z0-9.\-_]/.test(char) || cjkBreakRegex.test(char)) {
			triggerAutocompleteInCompletionContext(editor);
		}
	} else {
		editor.autocomplete.updateAutocomplete();
	}
}

export function handlePaste(editor: EditorModel, pastedText: string): void {
	editor.autocomplete.cancelAutocomplete();
	editor.exitHistoryBrowsing();
	editor.lastAction = null;

	editor.pushUndoSnapshot();

	// tmux re-encodes control bytes in a paste as extended keys; restore them so newlines survive the filter below.
	const decodedText = decodePastedControlKeys(pastedText);

	// Clean the pasted text: normalize line endings, expand tabs
	const cleanText = editor.normalizeText(decodedText);

	// Filter out non-printable characters except newlines
	let filteredText = cleanText.replace(/[\x00-\x09\x0b-\x1f]/g, "");

	// If pasting a file path (starts with /, ~, or .) and the character before
	// the cursor is a word character, prepend a space for better readability
	if (/^[/~.]/.test(filteredText)) {
		const currentLine = editor.state.lines[editor.state.cursorLine] || "";
		const charBeforeCursor = editor.state.cursorCol > 0 ? currentLine[editor.state.cursorCol - 1] : "";
		if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
			filteredText = ` ${filteredText}`;
		}
	}

	// Split into lines to check for large paste
	const pastedLines = filteredText.split("\n");

	// Check if this is a large paste (> 10 lines or > 1000 characters)
	const totalChars = filteredText.length;
	if (pastedLines.length > 10 || totalChars > 1000) {
		// Store the paste and insert a marker
		editor.pasteCounter++;
		const pasteId = editor.pasteCounter;
		editor.pastes.set(pasteId, filteredText);

		// Insert marker like "[paste #1 +123 lines]" or "[paste #1 1234 chars]"
		const marker =
			pastedLines.length > 10
				? `[paste #${pasteId} +${pastedLines.length} lines]`
				: `[paste #${pasteId} ${totalChars} chars]`;
		insertTextAtCursorInternal(editor, marker);
		return;
	}

	if (pastedLines.length === 1) {
		// Single line - insert atomically (do not trigger autocomplete during paste)
		insertTextAtCursorInternal(editor, filteredText);
		return;
	}

	// Multi-line paste - use direct state manipulation
	insertTextAtCursorInternal(editor, filteredText);
}

export function addNewLine(editor: EditorModel): void {
	editor.autocomplete.cancelAutocomplete();
	editor.exitHistoryBrowsing();
	editor.lastAction = null;

	editor.pushUndoSnapshot();

	const currentLine = editor.state.lines[editor.state.cursorLine] || "";

	const before = currentLine.slice(0, editor.state.cursorCol);
	const after = currentLine.slice(editor.state.cursorCol);

	editor.state.lines[editor.state.cursorLine] = before;
	editor.state.lines.splice(editor.state.cursorLine + 1, 0, after);

	editor.state.cursorLine++;
	editor.setCursorCol(0);

	editor.notifyChange();
}

export function shouldSubmitOnBackslashEnter(
	editor: EditorModel,
	data: string,
	kb: ReturnType<typeof getKeybindings>,
): boolean {
	if (editor.host.isSubmitDisabled()) return false;
	if (!matchesKey(data, "enter")) return false;
	const submitKeys = kb.getKeys("tui.input.submit");
	const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
	if (!hasShiftEnter) return false;

	const currentLine = editor.state.lines[editor.state.cursorLine] || "";
	return editor.state.cursorCol > 0 && currentLine[editor.state.cursorCol - 1] === "\\";
}

export function submitValue(editor: EditorModel): void {
	editor.autocomplete.cancelAutocomplete();
	const result = editor.expandPasteMarkers(editor.state.lines.join("\n")).trim();

	editor.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
	editor.pastes.clear();
	editor.pasteCounter = 0;
	editor.exitHistoryBrowsing();
	editor.scrollOffset = 0;
	editor.undoStack.clear();
	editor.lastAction = null;

	editor.host.notifySubmit(result);
}

export function handleBackspace(editor: EditorModel): void {
	editor.exitHistoryBrowsing();
	editor.lastAction = null;

	if (editor.state.cursorCol > 0) {
		editor.pushUndoSnapshot();

		// Delete grapheme before cursor (handles emojis, combining characters, etc.)
		const line = editor.state.lines[editor.state.cursorLine] || "";
		const beforeCursor = line.slice(0, editor.state.cursorCol);

		// Find the last grapheme in the text before cursor
		const graphemes = [...editor.segment(beforeCursor, "grapheme")];
		const lastGrapheme = graphemes[graphemes.length - 1];
		const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
		const isPastedSegmented = PASTE_MARKER_SINGLE.exec(lastGrapheme.segment);
		let before = line.slice(0, editor.state.cursorCol - graphemeLength);
		let after = line.slice(editor.state.cursorCol);

		if (isPastedSegmented) {
			// This contains the id part e.g 4 from [paste #4 +123 lines]
			const targetId = Number(isPastedSegmented[1]);
			editor.pastes.delete(targetId);
			editor.pasteCounter--;

			// Shift registry entries down in ascending id order, independent
			// of marker order in the text ([paste #3] becomes [paste #2] when
			// [paste #1] is removed).
			const higherIds = [...editor.pastes.keys()].filter((id) => id > targetId).sort((a, b) => a - b);
			for (const id of higherIds) {
				editor.pastes.set(id - 1, editor.pastes.get(id)!);
				editor.pastes.delete(id);
			}

			// Renumber markers with ids greater than the removed one. The cursor line is renumbered on each side of the
			// removed marker, so the cursor stays at its start when an earlier marker loses a digit (#10 becomes #9).
			const renumber = (text: string): string =>
				text.replace(PASTE_MARKER_REGEX, (fullMatch, idGroup, suffixGroup) => {
					const x = Number(idGroup);
					if (x <= targetId) return fullMatch;
					return `[paste #${x - 1}${suffixGroup ?? ""}]`;
				});
			editor.state.lines = editor.state.lines.map(renumber);
			before = renumber(before);
			after = renumber(after);
		}

		editor.state.lines[editor.state.cursorLine] = before + after;
		editor.setCursorCol(before.length);
	} else if (editor.state.cursorLine > 0) {
		editor.pushUndoSnapshot();
		mergeWithPreviousLine(editor);
	}

	editor.notifyChange();
	refreshAutocompleteAfterDelete(editor);
}

export function handleForwardDelete(editor: EditorModel): void {
	editor.exitHistoryBrowsing();
	editor.lastAction = null;

	const currentLine = editor.state.lines[editor.state.cursorLine] || "";

	if (editor.state.cursorCol < currentLine.length) {
		editor.pushUndoSnapshot();

		// Delete grapheme at cursor position (handles emojis, combining characters, etc.)
		const afterCursor = currentLine.slice(editor.state.cursorCol);

		// Find the first grapheme at cursor
		const graphemes = [...editor.segment(afterCursor, "grapheme")];
		const firstGrapheme = graphemes[0];
		const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

		const before = currentLine.slice(0, editor.state.cursorCol);
		const after = currentLine.slice(editor.state.cursorCol + graphemeLength);
		editor.state.lines[editor.state.cursorLine] = before + after;
	} else if (editor.state.cursorLine < editor.state.lines.length - 1) {
		editor.pushUndoSnapshot();
		mergeWithNextLine(editor);
	}

	editor.notifyChange();
	refreshAutocompleteAfterDelete(editor);
}

/** Join the cursor line onto the previous line and place the cursor at the join. */
export function mergeWithPreviousLine(editor: EditorModel): void {
	const currentLine = editor.state.lines[editor.state.cursorLine] || "";
	const previousLine = editor.state.lines[editor.state.cursorLine - 1] || "";
	editor.state.lines[editor.state.cursorLine - 1] = previousLine + currentLine;
	editor.state.lines.splice(editor.state.cursorLine, 1);
	editor.state.cursorLine--;
	editor.setCursorCol(previousLine.length);
}

/** Join the next line onto the cursor line without moving the cursor. */
export function mergeWithNextLine(editor: EditorModel): void {
	const currentLine = editor.state.lines[editor.state.cursorLine] || "";
	const nextLine = editor.state.lines[editor.state.cursorLine + 1] || "";
	editor.state.lines[editor.state.cursorLine] = currentLine + nextLine;
	editor.state.lines.splice(editor.state.cursorLine + 1, 1);
}

/** Update open autocomplete, or re-trigger it when a cancelled completion context is still active. */
function refreshAutocompleteAfterDelete(editor: EditorModel): void {
	if (editor.autocomplete.autocompleteState) {
		editor.autocomplete.updateAutocomplete();
	} else {
		triggerAutocompleteInCompletionContext(editor);
	}
}

/** Trigger autocomplete when the text before the cursor is a slash command or a symbol trigger such as @ or #. */
function triggerAutocompleteInCompletionContext(editor: EditorModel): void {
	const currentLine = editor.state.lines[editor.state.cursorLine] || "";
	const textBeforeCursor = currentLine.slice(0, editor.state.cursorCol);
	if (
		editor.isInSlashCommandContext(textBeforeCursor) ||
		editor.isInSkillMentionContext(textBeforeCursor) ||
		editor.autocomplete.autocompleteTriggerPattern.test(textBeforeCursor)
	) {
		editor.autocomplete.tryTriggerAutocomplete();
	}
}
