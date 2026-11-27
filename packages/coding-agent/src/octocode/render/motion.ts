import { LIGHT_GLYPH } from "@octocodeai/octocode-tui";
import { LIGHT_COLOR, type MarkTheme, type UiState } from "../../theme/status.ts";
import type { Phase } from "./types.ts";

/** The design state of a tool row's phase: the one map from what a row knows to the shared marks. */
export function uiStateOf(phase: Phase): UiState {
	return phase === "error" ? "failed" : phase;
}

/** Tool rows emphasize returned results: grey while running, green on success and red on failure. */
const TOOL_LIGHT_COLOR = { ...LIGHT_COLOR, running: "muted", done: "success" } as const;

/** The row's mark: its still state light. A row never animates, so it holds no clock subscription. */
export function rowMark(theme: MarkTheme, ui: UiState): string {
	return theme.fg(TOOL_LIGHT_COLOR[ui], LIGHT_GLYPH[ui]);
}
