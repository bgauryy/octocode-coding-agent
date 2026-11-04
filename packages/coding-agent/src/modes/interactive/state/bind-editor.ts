/**
 * Binds the editor slice to the editor component: when the border tone changes, the editor border and the active
 * status indicator are repainted. `applyEditorBorder` also serves the theme change, which keeps the tone but changes
 * its color.
 */

import { watchSelection } from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import type { InteractiveModeHost } from "../interactive-mode/host.ts";
import { selectEditorBorder, type EditorBorderTone } from "./editor-slice.ts";

type BindEditorHost = Pick<InteractiveModeHost, "activeStatusIndicator" | "editor" | "uiStore">;

/** Paints the editor border for `tone`. */
export function applyEditorBorder(host: BindEditorHost, tone: EditorBorderTone): void {
	host.editor.borderColor = tone === "bash" ? theme.getBashModeBorderColor() : theme.getThinkingBorderColor(tone);
	host.activeStatusIndicator?.invalidate();
}

/** Starts following the editor slice; returns the function that stops it. */
export function bindEditorState(host: BindEditorHost): () => void {
	return watchSelection(host.uiStore, selectEditorBorder, (tone) => applyEditorBorder(host, tone));
}
