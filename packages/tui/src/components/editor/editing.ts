import type { getKeybindings } from "../../keybindings.ts";
import { decodePastedControlKeys } from "../../paste-control-keys.ts";
import { matchesKey } from "../../keys/match.ts";
import { cjkBreakRegex, isWhitespaceChar } from "../../utils/chars.ts";
import { createUndoStack, type EditorModel } from "./model.ts";
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

	autocompleteAfterTyping(editor, char);
}

/** Opens or updates autocomplete after `char` was typed (the last character before the cursor). */
export function autocompleteAfterTyping(editor: EditorModel, char: string): void {
	if (!editor.autocomplete.autocompleteState) {
		if (typingTriggersAutocomplete(editor, char, editor.textBeforeCursor()))
			editor.autocomplete.tryTriggerAutocomplete();
	} else {
		editor.autocomplete.updateAutocomplete();
	}
}

/**
 * Whether typing `char`, the last character of `textBeforeCursor`, asks for suggestions while no list is open. `quote`:
 * the index of the last `"` in `textBeforeCursor`, when the caller tracks it.
 */
export function typingTriggersAutocomplete(
	editor: EditorModel,
	char: string,
	textBeforeCursor: string,
	quote?: number,
): boolean {
	// "/" at the start of the input (commands) or at any other token start (skills)
	if (char === "/" && (editor.isAtStartOfMessage(textBeforeCursor) || editor.isAtSkillMentionStart(textBeforeCursor))) {
		return true;
	}
	// Symbol-based completion like @, #, or provider triggers at token boundaries
	if (editor.autocomplete.autocompleteTriggerCharacters.includes(char)) {
		return editor.autocomplete.autocompleteTriggerPattern.test(textBeforeCursor, quote);
	}
	// Letters typed in a slash command or symbol completion context
	if (/[a-zA-Z0-9.\-_]/.test(char) || cjkBreakRegex.test(char))
		return inCompletionContext(editor, textBeforeCursor, quote);
	return false;
}

/**
 * The marker a large text (> 10 lines or > 1000 characters) shows as, `[paste #1 +123 lines]` or `[paste #1 1234 chars]`.
 * A newline that ends the text ends its last line: it starts no line of its own, so a copied 40-line file reads `+40`.
 */
export function largePasteMarker(id: number, text: string): string | undefined {
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	let lines = 1;
	for (let i = body.indexOf("\n"); i !== -1 && lines <= 10; i = body.indexOf("\n", i + 1)) lines++;
	if (lines > 10) return `[paste #${id} +${body.split("\n").length} lines]`;
	return text.length > 1000 ? `[paste #${id} ${text.length} chars]` : undefined;
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

	// Filter out control characters except newlines: C0, DEL and C1 (U+009B is an 8-bit CSI to some terminals)
	let filteredText = cleanText.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");

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

	const marker = largePasteMarker(editor.pasteCounter + 1, filteredText);
	if (marker) {
		// Store the paste and insert its marker instead of the text
		editor.pasteCounter++;
		editor.pastes.set(editor.pasteCounter, filteredText);
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

	// The cleared draft is kept whole: a refused submit restores it and history keeps its markers collapsed.
	editor.submitted = {
		state: editor.state,
		pastes: editor.pastes,
		pasteCounter: editor.pasteCounter,
		undo: editor.undoStack,
		text: result,
	};
	editor.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
	editor.pastes = new Map();
	editor.pasteCounter = 0;
	editor.exitHistoryBrowsing();
	editor.scrollOffset = 0;
	editor.undoStack = createUndoStack();
	editor.lastAction = null;

	editor.host.notifySubmit(result);
}

/** A draft's text with the paste registry its markers expand from. */
export interface DraftText {
	text: string;
	pastes: Map<number, string>;
	pasteCounter: number;
}

/**
 * The draft with `text` put before it, a blank line between them (a blank part is dropped), keeping the draft's paste
 * markers and registry. When `text` itself holds a marker the registry would expand, the draft joins it expanded and
 * without markers, so each part is sent as written.
 */
export function prependedDraft(editor: EditorModel, text: string): DraftText {
	const join = (draft: string) => [text, draft].filter((part) => part.trim()).join("\n\n");
	const draft = editor.state.lines.join("\n");
	for (const match of text.matchAll(PASTE_MARKER_REGEX)) {
		if (editor.pastes.has(Number(match[1]))) {
			return { text: join(editor.expandPasteMarkers(draft)), pastes: new Map(), pasteCounter: 0 };
		}
	}
	return { text: join(draft), pastes: new Map(editor.pastes), pasteCounter: editor.pasteCounter };
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

/** Whether the text before the cursor is in a slash command, a skill mention or a symbol trigger such as @ or #. */
export function inCompletionContext(editor: EditorModel, textBeforeCursor: string, quote?: number): boolean {
	return (
		editor.isInSlashCommandContext(textBeforeCursor) ||
		editor.isInSkillMentionContext(textBeforeCursor) ||
		editor.autocomplete.autocompleteTriggerPattern.test(textBeforeCursor, quote)
	);
}

/** Trigger autocomplete when the text before the cursor is a slash command or a symbol trigger such as @ or #. */
function triggerAutocompleteInCompletionContext(editor: EditorModel): void {
	if (inCompletionContext(editor, editor.textBeforeCursor())) editor.autocomplete.tryTriggerAutocomplete();
}
