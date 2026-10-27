import { animationClock, GLYPH, MOTION } from "@octocodeai/octocode-tui";
import { markFrameMs, markMoves, STATE_COLOR, stateMark, type MarkTheme, type UiState } from "../../../theme/status.ts";
import type { Phase, RenderContext, ToolRow } from "./types.ts";

/** The design state of a tool row's phase: the one map from what a row knows to the shared marks. */
export function uiStateOf(phase: Phase): UiState {
	return phase === "error" ? "failed" : phase;
}

/** Rows with a live subscription, so `stopRowMotion` can end the spinners a finished turn left behind. */
const subscribed = new Set<ToolRow>();

/**
 * The one row whose `✓` glows. A changed line above the viewport makes octocode-tui clear and redraw the whole
 * scrollback, so only the newest finished row (nearest the viewport) flashes; an older flash is cut short.
 */
let flashing: ToolRow | undefined;

function unsubscribe(state: ToolRow): void {
	state.unmark?.();
	state.unmark = undefined;
	state.marking = undefined;
	subscribed.delete(state);
}

/**
 * The row's mark, painted for its state. A row that moves (a spinner, or the one-time flash after it finishes) repaints
 * from the shared animation clock for as long as it moves, then lets go: the clock stops with its last subscriber and a
 * still screen writes nothing. Only a finish the user watched flashes: the row drew running at least one spinner frame
 * earlier. A row first drawn finished (a restored session) or drawn running and finished in one pass (a transcript
 * rebuild, which would otherwise re-flash every row above the viewport) does not; a finished row that still reads
 * `waiting` (a blocked agent) is drawn still: it has nothing left to wait for on screen.
 */
export function rowMark(theme: MarkTheme, context: RenderContext, state: ToolRow, ui: UiState): string {
	if (ui === "waiting" && context.isPartial === false) {
		unsubscribe(state);
		return theme.fg(STATE_COLOR.waiting, GLYPH.waiting);
	}
	const final = ui === "done" || ui === "failed" || ui === "stopped";
	const now = Date.now();
	if (ui === "running") state.spunAt ??= now;
	else if (final && state.settledAt === undefined) {
		const watched = state.spunAt !== undefined && now - state.spunAt >= MOTION.spinnerMs;
		// 0: settled long ago, so a row that did not earn a flash never gets one on a later redraw.
		state.settledAt = watched && ui === "done" ? now : 0;
		if (state.settledAt > 0) {
			if (flashing && flashing !== state) flashing.settledAt = 0;
			flashing = state;
		}
	}
	const options = { since: ui === "done" ? state.settledAt : undefined };
	const invalidate = context.invalidate;
	if (!invalidate || !markMoves(ui, options)) unsubscribe(state);
	else if (state.marking !== ui) {
		unsubscribe(state);
		state.marking = ui;
		state.unmark = animationClock.subscribe(() => invalidate(), { kind: "decor", everyMs: markFrameMs(ui) });
		subscribed.add(state);
	}
	return stateMark(theme, ui, options);
}

/**
 * Let go of the spinners a finished turn left running (`agent_end`, shutdown). A mark still glowing after its result
 * expires on its own within `MOTION.flashMs`.
 */
export function stopRowMotion(): void {
	for (const state of subscribed) if (state.marking === "running") unsubscribe(state);
}
