import type { ProgramStatus } from "../program-status.ts";

/**
 * Minimal terminal interface for TUI
 */
export interface Terminal {
	// Start the terminal with input and resize handlers
	start(onInput: (data: string) => void, onResize: () => void, onCapabilitiesChange?: () => void): void;

	// Stop the terminal and restore state
	stop(): void;

	/**
	 * Drain stdin before exiting to prevent Kitty key release events from
	 * leaking to the parent shell over slow SSH connections.
	 * @param maxMs - Maximum time to drain (default: 1000ms)
	 * @param idleMs - Exit early if no input arrives within this time (default: 50ms)
	 */
	drainInput(maxMs?: number, idleMs?: number): Promise<void>;

	// Write output to terminal
	write(data: string): void;

	/** Queued output bytes when the implementation can observe them; absent retains legacy rendering cadence. */
	readonly pendingOutputBytes?: number;
	/** Optional hint to omit decorative progress keepalives while scheduled frames are pressure-gated. */
	setDecorativeOutputPressureThreshold?(bytes: number | undefined): void;
	/** Optional aggregate output counters; no rendered text is retained. */
	setOutputTelemetryEnabled?(enabled: boolean): void;
	getOutputTelemetry?(): Readonly<OutputTelemetry>;

	// Get terminal dimensions
	get columns(): number;
	get rows(): number;

	// Whether Kitty keyboard protocol is active
	get kittyProtocolActive(): boolean;

	// Cursor positioning (relative to current position)
	moveBy(lines: number): void; // Move cursor up (negative) or down (positive) by N lines

	// Cursor visibility
	hideCursor(): void; // Hide the cursor
	showCursor(): void; // Show the cursor

	// Clear operations
	clearLine(): void; // Clear current line
	clearFromCursor(): void; // Clear from cursor to end of screen
	clearScreen(): void; // Clear entire screen and move cursor to (0,0)

	// Title operations
	setTitle(title: string): void; // Set terminal window title

	// Progress indicator (OSC 9;4)
	setProgress(active: boolean): void;

	/**
	 * Report what the program is doing (OSC 7501). Sent only to terminals that support it; the latest
	 * status is re-sent when support is confirmed or the terminal restarts.
	 */
	setProgramStatus(status: ProgramStatus): void;
}

export interface OutputTelemetry {
	writtenBytes: number;
	writeCalls: number;
	maxWriteBytes: number;
	backpressuredWrites: number;
	maxQueuedBytes: number;
}
