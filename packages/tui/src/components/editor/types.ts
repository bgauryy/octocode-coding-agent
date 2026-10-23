import type { SelectListTheme } from "../select-list.ts";

// Kitty CSI-u sequences for printable keys, including optional shifted/base codepoints.
export interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

/** Undo snapshot: editor text state plus the paste registry. */
export interface EditorSnapshot {
	state: EditorState;
	pastes: Map<number, string>;
	pasteCounter: number;
}

/** Last editing action, used for kill accumulation, yank-pop and undo coalescing. */
export type EditorLastAction = "kill" | "yank" | "type-word" | null;

export interface LayoutLine {
	text: string;
	hasCursor: boolean;
	cursorPos?: number;
}

export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
}

export interface EditorOptions {
	paddingX?: number;
	autocompleteMaxVisible?: number;
}
