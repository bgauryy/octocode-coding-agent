import type { ProgramStatus } from "../program-status.ts";

/**
 * Minimal terminal interface for TUI
 */
export interface Terminal {
	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void, onCapabilitiesChange?: () => void): void;

	stop(): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;
	/** True while `drainInput` runs: nothing that the terminal answers may be sent then. */
	readonly inputDraining?: boolean;
	/** Flush queued output before exit; false after the deadline or a stream error. */
	drainOutput?(maxMs?: number): Promise<boolean>;

	/**
	 * Queue output. A `frame` replaces what the screen shows and may be dropped while the terminal is not reading; the
	 * default, `essential`, is always written (modes, restoration, status, scrollback).
	 */
	write(data: string, kind?: OutputKind): void;
	/** Synchronous mode restoration on process exit, bypassing any unfinished stdout queue. */
	writeOnExit?(data: string): void;

	/** Queued output bytes when the implementation can observe them; absent retains legacy rendering cadence. */
	readonly pendingOutputBytes?: number;
	/** Optional hint to omit decorative progress keepalives while scheduled frames are pressure-gated. */
	setDecorativeOutputPressureThreshold?(bytes: number | undefined): void;
	/**
	 * Queued bytes past which frames are dropped (undefined keeps them all), and what repaints the screen whole once the
	 * queue drains after a drop.
	 */
	setFrameOutputCap?(bytes: number | undefined): void;
	/** Queued bytes past which frames are dropped; undefined when every frame is kept. */
	readonly frameOutputCap?: number;
	setOutputRecovery?(recover: (() => void) | undefined): void;
	/** Optional aggregate output counters; no rendered text is retained. */
	setOutputTelemetryEnabled?(enabled: boolean): void;
	getOutputTelemetry?(): Readonly<OutputTelemetry>;

	get columns(): number;
	get rows(): number;

	get kittyProtocolActive(): boolean;
	/**
	 * Whether the terminal confirmed synchronized output (mode 2026) through DECRQM. Absent or false: frames are paced
	 * to the display and written without begin/end markers.
	 */
	readonly synchronizedOutput?: boolean;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	hideCursor(): void;
	showCursor(): void;

	clearLine(): void;
	clearFromCursor(): void;
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	setTitle(title: string): void;

	// Progress indicator (OSC 9;4)
	setProgress(active: boolean): void;

	/**
	 * Report what the program is doing (OSC 7501). Sent only to terminals that support it; the latest
	 * status is re-sent when support is confirmed or the terminal restarts.
	 */
	setProgramStatus(status: ProgramStatus): void;
}

/** What a write holds: a replaceable frame, or bytes that must reach the terminal. */
export type OutputKind = "frame" | "essential";

export interface OutputTelemetry {
	writtenBytes: number;
	writeCalls: number;
	maxWriteBytes: number;
	backpressuredWrites: number;
	maxQueuedBytes: number;
	/** Bytes of frames dropped because the terminal was not reading. */
	droppedFrameBytes: number;
}
