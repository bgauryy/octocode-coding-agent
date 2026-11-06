import type { Component } from "@octocodeai/octocode-tui";
import type { Theme } from "../../../theme/theme.ts";

/** Renderer state kept per tool row (`context.state`). */
export interface ToolRow {
	/** When a row without a call id first drew as running (see `runStart`). */
	startedAt?: number;
	/** The row's elapsed-time clock is subscribed (see `track`). */
	ticking?: boolean;
	/** Ends the elapsed-time subscription; `releaseToolRowState` calls it when the row leaves the transcript. */
	unsubscribe?: () => void;
	/** The elapsed text the last tick asked a frame for: a tick that would draw the same text asks for none. */
	tickedText?: string;
	/** When the row first drew as waiting: its mark pulses from here for `WAIT_PULSE_MS`, then holds still. */
	waitedAt?: number;
	/** `checks 1.2s · queued 3s`: the time the call waited before it ran (see `timingOf`). */
	waits?: string;
	/** The call was interrupted (Esc, a kill, a requested stop), not failed: drawn `◼` in the warning colour. */
	stopped?: boolean;
	/** When the row first drew running: a finish after it visibly spun is news and flashes once (see `rowMark`). */
	spunAt?: number;
	/** When the row first drew as finished: the flash of its `✓` counts from here. */
	settledAt?: number;
	/** The state the row's animation subscription paints, and how to end it (see `rowMark`). */
	marking?: string;
	unmark?: () => void;
}

/** The part of Octocode's ToolRenderContext these helpers read. */
export interface RenderContext {
	lastComponent?: Component | undefined;
	state?: unknown;
	invalidate?: () => void;
	executionStarted?: boolean;
	isPartial?: boolean;
	isError?: boolean;
	expanded?: boolean;
	/** Octocode's recorded execution time, including when a completed row is restored. */
	durationMs?: number | undefined;
	/** The call's arguments (Octocode passes them to both renderers). */
	args?: unknown;
	/** The tool call the row draws; its run start is what `timed` recorded under it. */
	toolCallId?: string;
}

export type Phase = "pending" | "running" | "done" | "error" | "stopped";

export type ColorToken = Parameters<Theme["fg"]>[0];
