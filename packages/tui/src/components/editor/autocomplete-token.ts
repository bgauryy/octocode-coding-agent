import type { AutocompleteItem } from "../../autocomplete/types.ts";
import { isWhitespaceChar } from "../../utils/chars.ts";
import { DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS } from "./autocomplete-patterns.ts";
import type { SelectListOptions } from "../select-list.ts";
import type { EditorState } from "./types.ts";

const INDEXING_REFRESH_MS = 150;
const FILE_LIST_HINT = "↑↓ select · Tab/Enter insert · Esc close";

/** A token whose list the user closed with Esc: it stays closed until the cursor leaves the token. */
export interface DismissedToken {
	line: number;
	start: number;
	lead: string;
}

export const isDirectoryItem = (item: AutocompleteItem): boolean =>
	item.kind === "directory" || (item.kind === undefined && item.label.endsWith("/"));

function noFilesText(prefix: string): string {
	const query = prefix.slice(1).replace(/^"/, "");
	return query ? `No files match "${query}"` : "No files found";
}

const textBeforeCursor = (state: EditorState): string =>
	(state.lines[state.cursorLine] || "").slice(0, state.cursorCol);

/** The quote-free query when the text before the cursor ends in an `@` token, else null. */
export function findAtQuery(state: EditorState, triggerPattern: RegExp): string | null {
	const match = triggerPattern.exec(textBeforeCursor(state));
	const at = match ? match[0].indexOf("@") : -1;
	return match && at !== -1 ? match[0].slice(at + 1).replace(/^"/, "") : null;
}

/** Where the token under the cursor starts: from the open list's prefix, else from the trigger pattern. */
export function findTokenStart(
	state: EditorState,
	list: {
		autocompletePrefix: string;
		autocompleteTriggerPattern: RegExp;
		autocompleteTriggerCharacters: readonly string[];
	},
): DismissedToken | null {
	const {
		autocompletePrefix: prefix,
		autocompleteTriggerPattern: triggerPattern,
		autocompleteTriggerCharacters: triggerCharacters,
	} = list;
	const { cursorLine, cursorCol } = state;
	if (prefix && triggerCharacters.includes(prefix[0])) {
		return { line: cursorLine, start: cursorCol - prefix.length, lead: prefix[0] };
	}
	const match = triggerPattern.exec(textBeforeCursor(state));
	if (!match) return null;
	const chars = Array.from(match[0]);
	const offset = chars.findIndex((char) => triggerCharacters.includes(char));
	if (offset === -1) return null;
	return {
		line: cursorLine,
		start: cursorCol - match[0].length + chars.slice(0, offset).join("").length,
		lead: chars[offset],
	};
}

/** True while the cursor is on the dismissed token's line, after its lead character and before it ends. */
export function isInsideToken(token: DismissedToken, state: EditorState): boolean {
	const { cursorLine, cursorCol, lines } = state;
	const line = lines[cursorLine] || "";
	if (cursorLine !== token.line || cursorCol <= token.start || line[token.start] !== token.lead) return false;
	const segment = line.slice(token.start, cursorCol);
	const ended = segment.startsWith('@"') ? segment.indexOf('"', 2) !== -1 : /\s/.test(segment);
	return !ended;
}

/** Calls `onText` with fresh status text every tick until `read` returns nothing; returns a stop function. */
export function startProgressTicker(read: () => string | null | undefined, onText: (text: string) => void): () => void {
	const timer = setInterval(() => {
		const text = read();
		if (text) onText(text);
		else clearInterval(timer);
	}, INDEXING_REFRESH_MS);
	timer.unref?.();
	return () => clearInterval(timer);
}

/** Select-list options by prefix: `@` lists get the key hint and a "no files" row, others only a custom empty row. */
export function listOptions(prefix: string, emptyText?: string): SelectListOptions {
	if (prefix.startsWith("@")) return { hint: FILE_LIST_HINT, emptyText: emptyText ?? noFilesText(prefix) };
	return emptyText ? { emptyText } : {};
}

/** The default trigger characters plus the provider's single non-space, non-`/` characters. */
export function mergeTriggerCharacters(extra: readonly string[]): string[] {
	const merged = [...DEFAULT_AUTOCOMPLETE_TRIGGER_CHARACTERS];
	for (const character of extra) {
		if (character.length === 1 && character !== "/" && !isWhitespaceChar(character) && !merged.includes(character)) {
			merged.push(character);
		}
	}
	return merged;
}
