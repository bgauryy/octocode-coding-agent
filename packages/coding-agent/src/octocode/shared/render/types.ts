import type { Component } from "@octocodeai/octocode-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";

/** Renderer state kept per tool row (`context.state`). */
export interface ToolRow {
	/** When a row without a call id first drew as running (see `runStart`). */
	startedAt?: number;
	/** The row holds the clock now: it is the newest running row (see `track`). */
	ticking?: boolean;
	/** The row took the clock once; a row that lost it to a newer one never takes it back. */
	clocked?: boolean;
	/** `checks 1.2s · queued 3s`: the time the call waited before it ran (see `timingOf`). */
	waits?: string;
	/** The call was interrupted (Esc, a kill, a requested stop), not failed: drawn `◼` in the warning colour. */
	stopped?: boolean;
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
