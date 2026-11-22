import { animationClock } from "@octocodeai/octocode-tui";
import { markFrameMs, markMoves, stateMark, type MarkTheme, type UiState } from "../../theme/status.ts";
import type { Phase, RenderContext, ToolRow } from "./types.ts";

/** The design state of a tool row's phase: the one map from what a row knows to the shared marks. */
export function uiStateOf(phase: Phase): UiState {
	return phase === "error" ? "failed" : phase;
}

/** Rows with a live subscription, so `stopRowMotion` can end the spinners a finished turn left behind. */
const subscribed = new Set<ToolRow>();

function unsubscribe(state: ToolRow): void {
	state.unmark?.();
	state.unmark = undefined;
	state.marking = undefined;
	subscribed.delete(state);
}

/**
 * The row's mark, the state light painted for its state: a spinner while running, a steady ⏺ in the state's colour
 * after. Only a running row repaints from the shared animation clock, and lets go the moment it leaves `running`: the
 * clock stops with its last subscriber and a still screen writes nothing.
 */
export function rowMark(theme: MarkTheme, context: RenderContext, state: ToolRow, ui: UiState): string {
	const options = { light: true } as const;
	const invalidate = context.invalidate;
	if (!invalidate || !markMoves(ui, options)) unsubscribe(state);
	else if (state.marking !== ui) {
		unsubscribe(state);
		state.marking = ui;
		state.unmark = animationClock.subscribe(() => invalidate(), {
			kind: "decor",
			everyMs: markFrameMs(ui, options),
		});
		subscribed.add(state);
	}
	return stateMark(theme, ui, options);
}

/** Let go of the spinners a finished turn left running (`agent_end`, shutdown). */
export function stopRowMotion(): void {
	for (const state of subscribed) if (state.marking === "running") unsubscribe(state);
}
