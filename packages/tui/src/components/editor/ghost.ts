import { insertTextAtCursorInternal } from "./editing.ts";
import type { EditorModel } from "./model.ts";

/**
 * Inline suggestion ("ghost text"): a whole suggested input the app sets. While the text typed so far is a prefix of it
 * and the cursor is at the very end, the rest shows dimmed after the cursor. Typing on through it keeps it; anything
 * else hides it until the app sets a new one.
 */

/** The part of the suggestion still to type, or undefined when none shows. */
export function ghostSuffix(editor: EditorModel): string | undefined {
	const suggestion = editor.inlineSuggestion;
	if (!suggestion) return undefined;
	const { lines, cursorLine, cursorCol } = editor.state;
	if (cursorLine !== lines.length - 1 || cursorCol !== (lines[cursorLine] ?? "").length) return undefined;
	const text = lines.join("\n");
	if (suggestion.length <= text.length || !suggestion.startsWith(text)) return undefined;
	const rest = suggestion.slice(text.length);
	return rest.includes("\n") ? undefined : rest;
}

/** The next word of `rest`: leading spaces, then up to the next space or `/`, including it. */
function nextWord(rest: string): string {
	const match = /^\s*[^\s/]*[\s/]?/.exec(rest);
	return match?.[0] || rest;
}

/** Inserts the whole suggestion (`all`) or its next word as one undo step; false when none shows. */
export function acceptGhost(editor: EditorModel, mode: "all" | "word"): boolean {
	const rest = ghostSuffix(editor);
	if (!rest) return false;
	editor.pushUndoSnapshot();
	editor.lastAction = null;
	editor.exitHistoryBrowsing();
	insertTextAtCursorInternal(editor, mode === "all" ? rest : nextWord(rest));
	return true;
}

/** Dim text, the default ghost style. */
export const dimGhost = (text: string): string => `\x1b[2m${text}\x1b[22m`;
