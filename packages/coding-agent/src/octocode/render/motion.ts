import { stateMark, type MarkTheme, type UiState } from "../../theme/status.ts";
import type { Phase } from "./types.ts";

/** The design state of a tool row's phase: the one map from what a row knows to the shared marks. */
export function uiStateOf(phase: Phase): UiState {
	return phase === "error" ? "failed" : phase;
}

/** The row's mark: its still state light. A row never animates, so it holds no clock subscription. */
export function rowMark(theme: MarkTheme, ui: UiState): string {
	return stateMark(theme, ui, { light: true });
}
