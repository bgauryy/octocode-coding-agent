import { getKeybindings, type Keybinding } from "../../keybindings.ts";
import { autocompleteSeparatorRegex, cjkBreakRegex, isWhitespaceChar } from "../../utils/chars.ts";
import { autocompleteAfterTyping, inCompletionContext, typingTriggersAutocomplete } from "./editing.ts";
import { handleEditorInput } from "./input.ts";
import type { EditorModel } from "./model.ts";
import type { EditorState } from "./types.ts";

/** Every binding `handleEditorInput` checks before it inserts a printable key: a key that matches one takes that path. */
const EDITOR_BINDINGS: readonly Keybinding[] = [
	"tui.input.copy",
	"tui.editor.undo",
	"tui.select.cancel",
	"tui.select.up",
	"tui.select.down",
	"tui.select.confirm",
	"tui.input.tab",
	"tui.editor.deleteToLineEnd",
	"tui.editor.deleteToLineStart",
	"tui.editor.deleteWordBackward",
	"tui.editor.deleteWordForward",
	"tui.editor.deleteCharBackward",
	"tui.editor.deleteCharForward",
	"tui.editor.yank",
	"tui.editor.yankPop",
	"tui.editor.historyPrevious",
	"tui.editor.historyNext",
	"tui.editor.cursorLineStart",
	"tui.editor.cursorWordRight",
	"tui.editor.cursorLineEnd",
	"tui.editor.cursorWordLeft",
	"tui.input.newLine",
	"tui.input.submit",
	"tui.editor.cursorUp",
	"tui.editor.cursorDown",
	"tui.editor.cursorRight",
	"tui.editor.cursorLeft",
	"tui.editor.pageUp",
	"tui.editor.pageDown",
	"tui.editor.jumpForward",
	"tui.editor.jumpBackward",
];

/** Whether `char` reaches `insertCharacter` as a plain typed character (no binding, mode or open paste takes it). */
function insertsPlainly(editor: EditorModel, char: string): boolean {
	const code = char.codePointAt(0)!;
	if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false;
	if (editor.jumpMode !== null || editor.bracketedPaste.pasting) return false;
	// A forced (Tab) list may keep an older request alive when a key does not re-request: keep the per-key path.
	if (editor.autocomplete.autocompleteState === "force") return false;
	const kb = getKeybindings();
	const typed = kb.typedBindings(char);
	if (typed) return !EDITOR_BINDINGS.some((binding) => typed.has(binding));
	return !EDITOR_BINDINGS.some((binding) => kb.matches(char, binding));
}

/**
 * A character after which the completion context of the text before the cursor is unchanged: not whitespace or CJK
 * punctuation, a quote, a trigger character, an opening bracket, `/` or `@`. Each check (slash command, skill mention,
 * end-anchored trigger pattern) gives for `text + char` what it gave for `text`.
 */
function keepsContext(editor: EditorModel, char: string): boolean {
	if (char === '"' || char === "/" || char === "@" || "([{<`".includes(char)) return false;
	return !editor.autocomplete.autocompleteTriggerCharacters.includes(char) && !autocompleteSeparatorRegex.test(char);
}

/**
 * Insert `chars`, typed characters that arrived together, with the result of typing them one by one through
 * `insertCharacter`: the same text, cursor, undo steps (one per word, one per space), dismissal and pending suggestion
 * request. `onChange` runs once, with the final text. Assumes every character `insertsPlainly`.
 */
function insertRun(editor: EditorModel, chars: readonly string[]): void {
	editor.exitHistoryBrowsing();
	const { cursorLine, cursorCol } = editor.state;
	const line = editor.state.lines[cursorLine] || "";
	const before = line.slice(0, cursorCol);
	const after = line.slice(cursorCol);
	const autocomplete = editor.autocomplete;
	const listOpen = autocomplete.autocompleteState !== null;
	// typed(count): the first `count` characters, a slice of the whole run.
	const text = chars.join("");
	const ends = [0];
	for (const char of chars) ends.push(ends[ends.length - 1] + char.length);
	const typed = (count: number) => text.slice(0, ends[count]);
	const lines = editor.state.lines;
	const stateAt = (count: number): EditorState => {
		const next = [...lines];
		next[cursorLine] = before + typed(count) + after;
		return { lines: next, cursorLine, cursorCol: cursorCol + ends[count] };
	};
	// The first key re-checks an Esc dismissal where the cursor starts; later keys only move it forward.
	autocomplete.isDismissed();

	// The last character that asks for suggestions: its request is the one left pending, every earlier one cancelled.
	let lastTrigger = -1;
	let context: boolean | undefined;
	// The last `"` before the cursor, kept as characters are typed so no check searches the whole line for it.
	let quote = before.lastIndexOf('"');
	for (let k = 0; k < chars.length; k++) {
		const char = chars[k];
		if (char === '"') quote = before.length + ends[k];
		if (isWhitespaceChar(char) || editor.lastAction !== "type-word") {
			editor.undoStack.push({ state: stateAt(k), pastes: editor.pastes, pasteCounter: editor.pasteCounter });
		}
		editor.lastAction = "type-word";
		if (listOpen) {
			lastTrigger = k;
			continue;
		}
		const isWord = /[a-zA-Z0-9.\-_]/.test(char) || cjkBreakRegex.test(char);
		if (isWord && context !== undefined && keepsContext(editor, char)) {
			if (context) lastTrigger = k;
			continue;
		}
		const textBeforeCursor = before + typed(k + 1);
		if (isWord) {
			context = inCompletionContext(editor, textBeforeCursor, quote);
			if (context) lastTrigger = k;
		} else {
			context = keepsContext(editor, char) ? context : undefined;
			if (typingTriggersAutocomplete(editor, char, textBeforeCursor, quote)) lastTrigger = k;
		}
	}

	// Replay the last request where it was made, then land on the final text. Trigger characters clear an Esc
	// dismissal as they are typed; the dismissal is otherwise re-checked at the start of each key.
	const clearsDismissal = (from: number, to: number) =>
		chars.slice(from, to).some((char) => autocomplete.autocompleteTriggerCharacters.includes(char));
	if (lastTrigger !== -1) {
		editor.state = stateAt(lastTrigger + 1);
		if (clearsDismissal(0, lastTrigger + 1)) autocomplete.clearDismissal();
		autocompleteAfterTyping(editor, chars[lastTrigger]);
	}
	if (clearsDismissal(lastTrigger + 1, chars.length)) autocomplete.clearDismissal();
	editor.state = stateAt(chars.length - 1);
	autocomplete.isDismissed();
	editor.state = stateAt(chars.length);
	editor.setCursorCol(editor.state.cursorCol);
	editor.notifyChange();
}

/**
 * Typed characters that arrived in one terminal read: the plain ones at the start are inserted together (`insertRun`),
 * then the first other one goes through `handleEditorInput` alone. Returns how much of `text` was handled; the caller
 * hands the rest on, since that key may have moved focus.
 */
export function handleEditorTextRun(editor: EditorModel, text: string): number {
	const run: string[] = [];
	let used = 0;
	for (const char of text) {
		if (!insertsPlainly(editor, char)) break;
		run.push(char);
		used += char.length;
	}
	// The per-key path re-checks the dismissal before each key; a run of one is simply that key.
	if (run.length === 1) handleEditorInput(editor, run[0]);
	else if (run.length > 1) insertRun(editor, run);
	if (used < text.length) {
		const key = String.fromCodePoint(text.codePointAt(used)!);
		handleEditorInput(editor, key);
		used += key.length;
	}
	return used;
}

/**
 * A function put in place of an editor's `handleInput` that passes every key it does not take to `wraps`. Declaring
 * `takesTyped` (the typed characters it handles itself) lets a typed run reach the editor in one call.
 */
type TypedInputWrapper = ((data: string) => void) & {
	wraps?: (data: string) => void;
	takesTyped?: (char: string) => boolean;
};

/**
 * Deliver a typed run to an editor whose own key handling is `own`: `insert` takes the characters together and returns
 * how many it handled. A `handleInput` replaced on the editor gets the first character through `handleKey`, unless it is
 * a chain of `TypedInputWrapper`s down to `own`: then the characters up to the first one a wrapper takes (or whose check
 * throws) are inserted, and that one goes through `handleKey`. Returns how much of `text` was handled: it stops after
 * any key that `insert` or `handleKey` handled alone, since that key may have moved focus.
 */
export function routeTextRun(
	handleInput: (data: string) => void,
	own: (data: string) => void,
	text: string,
	insert: (run: string) => number,
	handleKey: (char: string) => void,
): number {
	const takes: Array<(char: string) => boolean> = [];
	let input = handleInput as TypedInputWrapper;
	while (input !== own && input.wraps && input.takesTyped) {
		takes.push(input.takesTyped);
		input = input.wraps;
	}
	const taken = (char: string) => {
		if (input !== own) return true;
		try {
			return takes.some((take) => take(char));
		} catch {
			return true;
		}
	};
	let run = 0;
	for (const char of text) {
		if (!taken(char)) {
			run += char.length;
			continue;
		}
		if (run > 0) return insert(text.slice(0, run));
		handleKey(char);
		return char.length;
	}
	return run > 0 ? insert(text) : 0;
}
