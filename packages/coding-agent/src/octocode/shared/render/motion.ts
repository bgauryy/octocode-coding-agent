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

/**
 * The one row whose mark moves on and on (a spinner, or the pulse of a row that waits). Every frame of a mark that
 * scrolled above the viewport makes octocode-tui clear and redraw the whole scrollback, header banner included, so
 * parallel calls flickered the screen ten times a second. Only the newest row to start moving animates; the row it
 * replaces is redrawn once, still, and does not move again in that state.
 */
let moving: { state: ToolRow; invalidate: () => void } | undefined;

/**
 * The row that started running last. Of parallel calls only it may flash on finishing: an older row finishing after it
 * has the newer rows' output below it, usually scrolled above the viewport, where every flash frame clears the scrollback.
 */
let newestStarted: ToolRow | undefined;

function releaseMoving(state: ToolRow): void {
	if (moving?.state === state) moving = undefined;
}

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
		releaseMoving(state);
		return theme.fg(STATE_COLOR.waiting, GLYPH.waiting);
	}
	const final = ui === "done" || ui === "failed" || ui === "stopped";
	const now = Date.now();
	if (ui === "running") {
		if (state.spunAt === undefined) newestStarted = state;
		state.spunAt ??= now;
	} else if (final && state.settledAt === undefined) {
		const watched = state.spunAt !== undefined && now - state.spunAt >= MOTION.spinnerMs && newestStarted === state;
		// 0: settled long ago, so a row that did not earn a flash never gets one on a later redraw.
		state.settledAt = watched && ui === "done" ? now : 0;
		if (state.settledAt > 0) {
			if (flashing && flashing !== state) flashing.settledAt = 0;
			flashing = state;
		}
	}
	const options = { since: ui === "done" ? state.settledAt : undefined };
	const invalidate = context.invalidate;
	const continuous = ui === "running" || ui === "waiting";
	if (!continuous) releaseMoving(state);
	else if (invalidate && markMoves(ui, options) && state.movedAs !== ui) {
		state.movedAs = ui;
		const previous = moving;
		moving = { state, invalidate };
		if (previous && previous.state !== state) {
			unsubscribe(previous.state);
			// Redrawn after this pass: invalidating another row from inside this row's render would re-enter the display.
			queueMicrotask(previous.invalidate);
		}
	}
	if (continuous && moving?.state !== state) {
		unsubscribe(state);
		return theme.fg(STATE_COLOR[ui], GLYPH[ui]);
	}
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
	moving = undefined;
	newestStarted = undefined;
}
