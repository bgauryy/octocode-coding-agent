import type { Component } from "@octocodeai/octocode-tui";
import { STATE_COLOR } from "../../theme/status.ts";
import type { Theme } from "../../theme/theme.ts";

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
	/** `checks 1.2s · queued 3s`: the time the call waited before it ran (see `timingOf`). */
	waits?: string;
	/** The call was interrupted (Esc, a kill, a requested stop), not failed: drawn `◼` in the warning colour. */
	stopped?: boolean;
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
	/** The working directory relative paths in the row resolve against (links). */
	cwd?: string;
	/** The call's arguments (Octocode passes them to both renderers). */
	args?: unknown;
	/** The tool call the row draws; its run start is what `timed` recorded under it. */
	toolCallId?: string;
}

export type Phase = "pending" | "running" | "done" | "error" | "stopped";

export type ColorToken = Parameters<Theme["fg"]>[0];

/**
 * The one tone of an interrupted call: its text, the assistant's `Interrupted` line and a stopped reasoning label.
 * The `◼` mark uses the same token.
 */
export const STOPPED_COLOR: ColorToken = STATE_COLOR.stopped;
