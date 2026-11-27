/**
 * Editor slice of the interactive UI store: whether the draft is a `!` bash command and the thinking level the
 * editor border reflects. The border tone is derived by `selectEditorBorder`, so the border is repainted exactly when
 * the tone changes.
 */

import type { StoreApi } from "zustand/vanilla";
import type { Theme } from "../../../theme/theme.ts";

type EditorThinkingLevel = Parameters<Theme["getThinkingBorderColor"]>[0];

/** What the editor border shows: the bash color, or the color of a thinking level. */
export type EditorBorderTone = "bash" | EditorThinkingLevel;

export interface EditorSlice {
	bashMode: boolean;
	thinkingLevel: EditorThinkingLevel;
}

export interface EditorActions {
	setBashMode(bash: boolean): void;
	setThinkingLevel(level: EditorThinkingLevel): void;
}

export interface EditorState {
	editor: EditorSlice;
}

type Get = StoreApi<EditorState & EditorActions>["getState"];
type Set = StoreApi<EditorState & EditorActions>["setState"];

export const initialEditorSlice = (init: Partial<EditorSlice> = {}): EditorSlice => ({
	bashMode: false,
	thinkingLevel: "off",
	...init,
});

export const selectEditorBorder = (state: EditorState): EditorBorderTone =>
	state.editor.bashMode ? "bash" : state.editor.thinkingLevel;

export function createEditorActions(set: Set, get: Get): EditorActions {
	return {
		setBashMode(bash) {
			if (bash === get().editor.bashMode) return;
			set((state) => ({ editor: { ...state.editor, bashMode: bash } }));
		},
		setThinkingLevel(level) {
			if (level === get().editor.thinkingLevel) return;
			set((state) => ({ editor: { ...state.editor, thinkingLevel: level } }));
		},
	};
}
