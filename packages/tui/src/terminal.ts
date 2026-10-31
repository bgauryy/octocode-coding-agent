import * as fs from "node:fs";
import * as path from "node:path";
import { setKittyProtocolActive } from "./keys/state.ts";
import { isNativeModifierPressed } from "./native-modifiers.ts";
import { getNativePlatformHelper } from "./native-platform.ts";
import {
	formatProgramStatus,
	isProgramStatusReply,
	PROGRAM_STATUS_QUERY,
	type ProgramStatus,
} from "./program-status.ts";
import { PASTE_IDLE_TIMEOUT_MS, StdinBuffer } from "./stdin-buffer.ts";
import { KittyGraphicsProbe } from "./terminal-image/probe.ts";

const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = "\x1b]9;4;0\x07";
const NATIVE_SHIFT_ENTER_SEQUENCE = "\x1b[13;2u";
const DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS = 7;
const KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS = 150;
const KITTY_KEYBOARD_PROTOCOL_QUERY = `\x1b[>${DESIRED_KITTY_KEYBOARD_PROTOCOL_FLAGS}u\x1b[?u`;
/** Primary device attributes (DA1) request; every terminal answers it, in order with earlier queries. */
export const DEVICE_ATTRIBUTES_QUERY = "\x1b[c";
/** Matches a DA1 reply such as `ESC [ ? 62 ; 22 c`. */
export const DEVICE_ATTRIBUTES_RESPONSE_PATTERN = /^\x1b\[\?[\d;]*c$/;

type KeyboardProtocolNegotiationSequence = { type: "kitty-flags"; flags: number } | { type: "device-attributes" };

function parseKeyboardProtocolNegotiationSequence(sequence: string): KeyboardProtocolNegotiationSequence | undefined {
	const kittyFlags = sequence.match(/^\x1b\[\?(\d+)u$/);
	if (kittyFlags) {
		return { type: "kitty-flags", flags: Number.parseInt(kittyFlags[1], 10) };
	}
	if (DEVICE_ATTRIBUTES_RESPONSE_PATTERN.test(sequence)) {
		return { type: "device-attributes" };
	}
	return undefined;
}

function isKeyboardProtocolNegotiationSequencePrefix(sequence: string): boolean {
	return sequence === "\x1b[" || /^\x1b\[\?[\d;]*$/.test(sequence);
}

export function isAppleTerminalSession(): boolean {
	return process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal";
}

/**
 * Refresh terminal dimensions on POSIX platforms by sending SIGWINCH to this process.
 * Best-effort: some environments (restricted seccomp or LSM policies) return EACCES
 * for `kill(2)`; in that case the dimensions refresh is skipped rather than crashing.
 */
export function refreshTerminalDimensions(): void {
	if (process.platform === "win32" || process.pid <= 0) return;
	try {
		process.kill(process.pid, "SIGWINCH");
	} catch {
		// Signal delivery not permitted in this environment; ignore.
	}
}

export function normalizeNativeShiftEnterInput(
	data: string,
	shouldDetectNativeShiftEnter: boolean,
	isShiftPressed: boolean,
): string {
	if (shouldDetectNativeShiftEnter && data === "\r" && isShiftPressed) return NATIVE_SHIFT_ENTER_SEQUENCE;
	return data;
}

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

const DEFAULT_ESCAPE_TIMEOUT_MS = 10;
const DEFAULT_SSH_ESCAPE_TIMEOUT_MS = 100;

/** A positive number in the environment variable, else the SSH default over SSH, else the local default. */
function resolveTimeoutMs(
	env: NodeJS.ProcessEnv,
	variable: string,
	localDefaultMs: number,
	sshDefaultMs: number,
): number {
	const configured = Number(env[variable]);
	if (Number.isFinite(configured) && configured > 0) return configured;
	return env.SSH_CONNECTION || env.SSH_TTY ? sshDefaultMs : localDefaultMs;
}

/**
 * Resolve how long to wait for the rest of an escape sequence before
 * dispatching a lone ESC as the Escape key. Legacy Alt+key input is ESC plus
 * another byte, so high-latency transports need a longer reassembly window.
 */
export function resolveEscapeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	return resolveTimeoutMs(env, "OCTOCODE_TUI_ESC_TIMEOUT", DEFAULT_ESCAPE_TIMEOUT_MS, DEFAULT_SSH_ESCAPE_TIMEOUT_MS);
}

/** Over SSH a paste can stall longer between chunks, so its end marker is awaited longer. */
const DEFAULT_SSH_PASTE_TIMEOUT_MS = 3000;

/** How long a bracketed paste may go without input before it is emitted without its end marker. */
export function resolvePasteTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	return resolveTimeoutMs(env, "OCTOCODE_TUI_PASTE_TIMEOUT", PASTE_IDLE_TIMEOUT_MS, DEFAULT_SSH_PASTE_TIMEOUT_MS);
}

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	private decorativeOutputPressureThreshold: number | undefined;
	private outputTelemetryEnabled = false;
	private outputTelemetry: OutputTelemetry = {
		writtenBytes: 0,
		writeCalls: 0,
		maxWriteBytes: 0,
		backpressuredWrites: 0,
		maxQueuedBytes: 0,
	};

	get pendingOutputBytes(): number {
		return process.stdout.writableLength;
	}

	setDecorativeOutputPressureThreshold(bytes: number | undefined): void {
		this.decorativeOutputPressureThreshold = bytes;
	}

	setOutputTelemetryEnabled(enabled: boolean): void {
		if (enabled && !this.outputTelemetryEnabled) {
			this.outputTelemetry = {
				writtenBytes: 0,
				writeCalls: 0,
				maxWriteBytes: 0,
				backpressuredWrites: 0,
				maxQueuedBytes: 0,
			};
		}
		this.outputTelemetryEnabled = enabled;
	}

	getOutputTelemetry(): Readonly<OutputTelemetry> {
		return { ...this.outputTelemetry };
	}
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private capabilitiesHandler?: () => void;
	private readonly graphicsProbe = new KittyGraphicsProbe();
	private _kittyProtocolActive = false;
	private _modifyOtherKeysActive = false;
	private keyboardProtocolPushed = false;
	/** DA1 replies owed to keyboard protocol queries. Later DA1 replies answer other queries and are forwarded. */
	private pendingKeyboardProtocolDeviceAttributes = 0;
	private keyboardProtocolNegotiationBuffer = "";
	private keyboardProtocolBufferFlushTimer?: ReturnType<typeof setTimeout>;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private progressInterval?: ReturnType<typeof setInterval>;
	/** Latest program status, kept across stop() so start() can report it again. */
	private programStatus?: ProgramStatus;
	/** Whether the terminal confirmed OSC 7501 support since the last start(), or `OCTOCODE_PROGRAM_STATUS=1`. */
	private programStatusSupported = false;
	/** The support query was sent and its DA1 sentinel has not arrived yet. */
	private programStatusQueryPending = false;
	private writeLogPath = (() => {
		const env = process.env.OCTOCODE_TUI_WRITE_LOG || "";
		if (!env) return "";
		try {
			if (fs.statSync(env).isDirectory()) {
				const now = new Date();
				const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
				return path.join(env, `tui-${ts}-${process.pid}.log`);
			}
		} catch {
			// Not an existing directory - use as-is (file path)
		}
		return env;
	})();

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	get modifyOtherKeysActive(): boolean {
		return this._modifyOtherKeysActive;
	}

	start(onInput: (data: string) => void, onResize: () => void, onCapabilitiesChange?: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		this.capabilitiesHandler = onCapabilitiesChange;

		// Save previous state and enable raw mode
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		process.stdout.write("\x1b[?2004h");

		// Set up resize handler immediately
		process.stdout.on("resize", this.resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only, best-effort.
		refreshTerminalDimensions();

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		this.enableWindowsVTInput();

		// Query Kitty keyboard protocol and fall back to modifyOtherKeys when DA confirms no Kitty response.
		// See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/
		this.queryAndEnableKittyProtocol();
	}

	/**
	 * Set up StdinBuffer to split batched input into individual sequences.
	 * This ensures components receive single events, making matchesKey/isKeyRelease work correctly.
	 *
	 * Also watches for Kitty protocol response and enables it when detected.
	 * This is done here (after stdinBuffer parsing) rather than on raw stdin
	 * to handle the case where the response arrives split across multiple events.
	 */
	private setupStdinBuffer(): void {
		this.stdinBuffer = new StdinBuffer({
			escapeTimeout: resolveEscapeTimeoutMs(),
			pasteTimeout: resolvePasteTimeoutMs(),
		});

		// Forward individual sequences to the input handler
		this.stdinBuffer.on("data", (sequence) => {
			if (this.graphicsProbe.consume(sequence)) return;
			if (isProgramStatusReply(sequence)) {
				if (this.programStatusQueryPending) {
					this.programStatusQueryPending = false;
					this.programStatusSupported = true;
					this.writeProgramStatus();
				}
				return;
			}
			const negotiation = this.readKeyboardProtocolNegotiationSequence(sequence);
			if (negotiation === "pending") {
				this.scheduleKeyboardProtocolNegotiationBufferFlush();
				return; // Wait briefly for the rest of a split Kitty response.
			}
			if (negotiation && this.handleKeyboardProtocolNegotiationSequence(negotiation.parsed)) {
				return;
			}

			this.forwardInputSequence(negotiation?.sequence ?? sequence);
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.stdinDataHandler = (data: string) => {
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * Query terminal for Kitty keyboard protocol support and enable it if available.
	 *
	 * Kitty's progressive enhancement detection requires requesting the desired
	 * flags before querying them. The trailing DA query is a sentinel supported by
	 * terminals that do not know Kitty keyboard protocol; receiving DA before a
	 * Kitty response enables modifyOtherKeys fallback without a startup timeout.
	 *
	 * The requested flags are:
	 * - 1 = disambiguate escape codes
	 * - 2 = report event types (press/repeat/release)
	 * - 4 = report alternate keys (shifted key, base layout key)
	 *
	 * The OSC 7501 program status query shares the DA sentinel: a terminal that supports it replies
	 * before DA. `OCTOCODE_PROGRAM_STATUS=1` or `0` skips the query.
	 */
	private queryAndEnableKittyProtocol(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		this.keyboardProtocolPushed = true;
		this.pendingKeyboardProtocolDeviceAttributes += 1;
		this.clearKeyboardProtocolNegotiationBuffer();
		const programStatusOverride = process.env.OCTOCODE_PROGRAM_STATUS;
		this.programStatusSupported = programStatusOverride === "1";
		this.programStatusQueryPending = programStatusOverride !== "1" && programStatusOverride !== "0";
		const programStatusQuery = this.programStatusQueryPending ? PROGRAM_STATUS_QUERY : "";
		const graphicsQuery = this.graphicsProbe.start(
			Boolean(process.stdin.isTTY && process.stdout.isTTY),
			this.capabilitiesHandler,
		);
		process.stdout.write(
			`${KITTY_KEYBOARD_PROTOCOL_QUERY}${programStatusQuery}${graphicsQuery}${DEVICE_ATTRIBUTES_QUERY}`,
		);
		this.writeProgramStatus();
	}

	private handleKeyboardProtocolNegotiationSequence(negotiationSequence: KeyboardProtocolNegotiationSequence): boolean {
		this.clearKeyboardProtocolNegotiationBuffer();
		if (negotiationSequence.type === "device-attributes") {
			if (this.pendingKeyboardProtocolDeviceAttributes === 0) return false;
			this.pendingKeyboardProtocolDeviceAttributes -= 1;
			// The last owed DA answers the latest query, which got no program status reply first. Earlier DA
			// replies belong to queries from before a restart.
			if (this.pendingKeyboardProtocolDeviceAttributes === 0) {
				this.programStatusQueryPending = false;
				this.graphicsProbe.finish();
			}
		}
		if (negotiationSequence.type === "kitty-flags") {
			if (negotiationSequence.flags !== 0) {
				this.disableModifyOtherKeys();
				if (!this._kittyProtocolActive) {
					this._kittyProtocolActive = true;
					setKittyProtocolActive(true);
				}
			} else {
				this.enableModifyOtherKeys();
			}
			return true;
		}

		if (!this._kittyProtocolActive) {
			this.enableModifyOtherKeys();
		}
		return true;
	}

	/** Returns the parsed negotiation reply with its full (possibly reassembled) sequence. */
	private readKeyboardProtocolNegotiationSequence(
		sequence: string,
	): { parsed: KeyboardProtocolNegotiationSequence; sequence: string } | "pending" | undefined {
		if (this.keyboardProtocolNegotiationBuffer) {
			const bufferedSequence = this.keyboardProtocolNegotiationBuffer + sequence;
			const negotiationSequence = parseKeyboardProtocolNegotiationSequence(bufferedSequence);
			if (negotiationSequence) {
				this.clearKeyboardProtocolNegotiationBuffer();
				return { parsed: negotiationSequence, sequence: bufferedSequence };
			}
			if (isKeyboardProtocolNegotiationSequencePrefix(bufferedSequence)) {
				this.setKeyboardProtocolNegotiationBuffer(bufferedSequence);
				return "pending";
			}
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}

		const negotiationSequence = parseKeyboardProtocolNegotiationSequence(sequence);
		if (negotiationSequence) return { parsed: negotiationSequence, sequence };
		if (isKeyboardProtocolNegotiationSequencePrefix(sequence)) {
			this.setKeyboardProtocolNegotiationBuffer(sequence);
			return "pending";
		}
		return undefined;
	}

	private setKeyboardProtocolNegotiationBuffer(sequence: string): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = sequence;
	}

	private clearKeyboardProtocolNegotiationBuffer(): void {
		this.clearKeyboardProtocolNegotiationBufferFlushTimer();
		this.keyboardProtocolNegotiationBuffer = "";
	}

	private flushKeyboardProtocolNegotiationBufferAsInput(): void {
		if (!this.keyboardProtocolNegotiationBuffer) return;
		const sequence = this.keyboardProtocolNegotiationBuffer;
		this.clearKeyboardProtocolNegotiationBuffer();
		this.forwardInputSequence(sequence);
	}

	private scheduleKeyboardProtocolNegotiationBufferFlush(): void {
		if (!this.keyboardProtocolNegotiationBuffer || this.keyboardProtocolBufferFlushTimer) return;
		this.keyboardProtocolBufferFlushTimer = setTimeout(() => {
			this.keyboardProtocolBufferFlushTimer = undefined;
			this.flushKeyboardProtocolNegotiationBufferAsInput();
		}, KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS);
	}

	private clearKeyboardProtocolNegotiationBufferFlushTimer(): void {
		if (!this.keyboardProtocolBufferFlushTimer) return;
		clearTimeout(this.keyboardProtocolBufferFlushTimer);
		this.keyboardProtocolBufferFlushTimer = undefined;
	}

	private forwardInputSequence(sequence: string): void {
		if (!this.inputHandler) return;
		const shouldDetectNativeShiftEnter =
			sequence === "\r" && (isAppleTerminalSession() || process.platform === "win32");
		const input = normalizeNativeShiftEnterInput(
			sequence,
			shouldDetectNativeShiftEnter,
			shouldDetectNativeShiftEnter && isNativeModifierPressed("shift"),
		);
		this.inputHandler(input);
	}

	private enableModifyOtherKeys(): void {
		if (this._kittyProtocolActive || this._modifyOtherKeysActive) return;
		process.stdout.write("\x1b[>4;2m");
		this._modifyOtherKeysActive = true;
	}

	/** Drop pending protocol negotiation and turn off the Kitty keyboard protocol and modifyOtherKeys; safe to repeat. */
	private disableKeyboardProtocols(): void {
		const shouldDisableKittyProtocol = this.keyboardProtocolPushed || this._kittyProtocolActive;
		this.clearKeyboardProtocolNegotiationBuffer();
		if (shouldDisableKittyProtocol) {
			process.stdout.write("\x1b[<u");
			this.keyboardProtocolPushed = false;
			this._kittyProtocolActive = false;
			setKittyProtocolActive(false);
		}
		this.disableModifyOtherKeys();
	}

	private disableModifyOtherKeys(): void {
		if (!this._modifyOtherKeysActive) return;
		process.stdout.write("\x1b[>4;0m");
		this._modifyOtherKeysActive = false;
	}

	/**
	 * On Windows, add ENABLE_VIRTUAL_TERMINAL_INPUT (0x0200) to the stdin
	 * console handle so the terminal sends VT sequences for modified keys
	 * (e.g. \x1b[Z for Shift+Tab). Without this, libuv's ReadConsoleInputW
	 * discards modifier state and Shift+Tab arrives as plain \t.
	 */
	private enableWindowsVTInput(): void {
		if (process.platform !== "win32") return;
		try {
			getNativePlatformHelper()?.enableVirtualTerminalInput?.();
		} catch {
			// Native helper not available — Shift+Tab won't be distinguishable from Tab.
		}
	}

	async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
		this.graphicsProbe.stop();
		// Disable the keyboard protocols first so any late key releases
		// do not generate new Kitty escape sequences.
		this.disableKeyboardProtocols();

		const previousHandler = this.inputHandler;
		this.inputHandler = undefined;

		let lastDataTime = Date.now();
		const onData = () => {
			lastDataTime = Date.now();
		};

		process.stdin.on("data", onData);
		const endTime = Date.now() + maxMs;

		try {
			while (true) {
				const now = Date.now();
				const timeLeft = endTime - now;
				if (timeLeft <= 0) break;
				if (now - lastDataTime >= idleMs) break;
				await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
			}
		} finally {
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	stop(): void {
		this.graphicsProbe.stop();
		this.capabilitiesHandler = undefined;
		if (this.clearProgressInterval()) {
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
		// Remove the status while stopped, for example after exit or while suspended. start() reports it again.
		if (this.programStatusSupported && this.programStatus) {
			process.stdout.write(formatProgramStatus({ state: "clear" }));
		}
		this.programStatusSupported = false;
		this.programStatusQueryPending = false;

		// Disable bracketed paste mode
		process.stdout.write("\x1b[?2004l");

		// Disable the keyboard protocols if drainInput() has not already done so.
		this.disableKeyboardProtocols();

		// Clean up StdinBuffer
		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

		// Remove event handlers
		if (this.stdinDataHandler) {
			process.stdin.removeListener("data", this.stdinDataHandler);
			this.stdinDataHandler = undefined;
		}
		this.inputHandler = undefined;
		if (this.resizeHandler) {
			process.stdout.removeListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// Pause stdin to prevent any buffered input (e.g., Ctrl+D) from being
		// re-interpreted after raw mode is disabled. This fixes a race condition
		// where Ctrl+D could close the parent shell over SSH.
		process.stdin.pause();

		// Restore raw mode state
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
	}

	write(data: string): void {
		const accepted = process.stdout.write(data);
		if (this.outputTelemetryEnabled) {
			const bytes = Buffer.byteLength(data);
			this.outputTelemetry.writtenBytes += bytes;
			this.outputTelemetry.writeCalls++;
			this.outputTelemetry.maxWriteBytes = Math.max(this.outputTelemetry.maxWriteBytes, bytes);
			if (!accepted) this.outputTelemetry.backpressuredWrites++;
			this.outputTelemetry.maxQueuedBytes = Math.max(this.outputTelemetry.maxQueuedBytes, this.pendingOutputBytes);
		}
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	get columns(): number {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	moveBy(lines: number): void {
		if (lines > 0) {
			// Move down
			process.stdout.write(`\x1b[${lines}B`);
		} else if (lines < 0) {
			// Move up
			process.stdout.write(`\x1b[${-lines}A`);
		}
		// lines === 0: no movement
	}

	hideCursor(): void {
		process.stdout.write("\x1b[?25l");
	}

	showCursor(): void {
		process.stdout.write("\x1b[?25h");
	}

	clearLine(): void {
		process.stdout.write("\x1b[K");
	}

	clearFromCursor(): void {
		process.stdout.write("\x1b[J");
	}

	clearScreen(): void {
		process.stdout.write("\x1b[2J\x1b[H"); // Clear screen and move to home (1,1)
	}

	setTitle(title: string): void {
		// OSC 0;title BEL - set terminal window title. A control character (BEL, ESC, C1) would end the sequence early.
		process.stdout.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f-\x9f]/g, "")}\x07`);
	}

	setProgramStatus(status: ProgramStatus): void {
		this.programStatus = status.state === "clear" ? undefined : status;
		if (this.programStatusSupported) process.stdout.write(formatProgramStatus(status));
	}

	private writeProgramStatus(): void {
		if (this.programStatusSupported && this.programStatus) {
			process.stdout.write(formatProgramStatus(this.programStatus));
		}
	}

	setProgress(active: boolean): void {
		if (active) {
			// OSC 9;4;3 - indeterminate progress
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
			if (!this.progressInterval) {
				this.progressInterval = setInterval(() => {
					if (
						this.decorativeOutputPressureThreshold === undefined ||
						this.pendingOutputBytes <= this.decorativeOutputPressureThreshold
					) {
						process.stdout.write(TERMINAL_PROGRESS_ACTIVE_SEQUENCE);
					}
				}, TERMINAL_PROGRESS_KEEPALIVE_MS);
			}
		} else {
			this.clearProgressInterval();
			// OSC 9;4;0 - clear progress
			process.stdout.write(TERMINAL_PROGRESS_CLEAR_SEQUENCE);
		}
	}

	private clearProgressInterval(): boolean {
		if (!this.progressInterval) return false;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		return true;
	}
}
