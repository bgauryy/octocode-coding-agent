import { isNativeModifierPressed } from "./native-modifiers.ts";
import { getNativePlatformHelper } from "./native-platform.ts";
import type { ProgramStatus } from "./program-status.ts";
import { hasTmuxSession } from "./multiplexer.ts";
import { StdinBuffer } from "./stdin-buffer.ts";
import { BracketedPasteRearm, DISABLE_BRACKETED_PASTE, ENABLE_BRACKETED_PASTE } from "./terminal/bracketed-paste.ts";
import { DEVICE_ATTRIBUTES_QUERY } from "./terminal/device-attributes.ts";
import {
	isAppleTerminalSession,
	normalizeNativeShiftEnterInput,
	refreshTerminalDimensions,
	resolveEscapeTimeoutMs,
	resolvePasteTimeoutMs,
} from "./terminal/environment.ts";
import { KeyboardProtocol, KITTY_KEYBOARD_PROTOCOL_QUERY } from "./terminal/keyboard-protocol.ts";
import { TerminalOutput } from "./terminal/output.ts";
import { ProgramStatusReporter } from "./terminal/program-status-reporter.ts";
import { ProgressIndicator } from "./terminal/progress.ts";
import type { OutputTelemetry, Terminal } from "./terminal/types.ts";
import { KittyGraphicsProbe } from "./terminal-image/probe.ts";

export {
	isAppleTerminalSession,
	normalizeNativeShiftEnterInput,
	refreshTerminalDimensions,
	resolveEscapeTimeoutMs,
	resolvePasteTimeoutMs,
} from "./terminal/environment.ts";
export type { OutputTelemetry, Terminal } from "./terminal/types.ts";

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	private readonly output = new TerminalOutput();
	private readonly programStatusReporter = new ProgramStatusReporter();
	private readonly progress = new ProgressIndicator(() => this.output.allowsDecorativeOutput());
	private readonly graphicsProbe = new KittyGraphicsProbe();
	private readonly keyboardProtocol = new KeyboardProtocol({
		forward: (sequence) => this.forwardInputSequence(sequence),
		onLastDeviceAttributes: () => {
			this.programStatusReporter.settleQuery();
			this.graphicsProbe.finish();
		},
	});
	private readonly bracketedPaste = new BracketedPasteRearm({
		isEnabled: () => hasTmuxSession(),
		write: (sequence) => process.stdout.write(sequence),
		isPasting: () => this.stdinBuffer?.pasting ?? false,
	});
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private capabilitiesHandler?: () => void;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;

	get pendingOutputBytes(): number {
		return this.output.pendingBytes;
	}

	setDecorativeOutputPressureThreshold(bytes: number | undefined): void {
		this.output.setDecorativePressureThreshold(bytes);
	}

	setOutputTelemetryEnabled(enabled: boolean): void {
		this.output.setTelemetryEnabled(enabled);
	}

	getOutputTelemetry(): Readonly<OutputTelemetry> {
		return this.output.getTelemetry();
	}

	get kittyProtocolActive(): boolean {
		return this.keyboardProtocol.kittyProtocolActive;
	}

	get modifyOtherKeysActive(): boolean {
		return this.keyboardProtocol.modifyOtherKeysActive;
	}

	start(onInput: (data: string) => void, onResize: () => void, onCapabilitiesChange?: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = () => {
			this.bracketedPaste.activity();
			onResize();
		};
		this.capabilitiesHandler = onCapabilitiesChange;

		// Save previous state and enable raw mode
		this.wasRaw = process.stdin.isRaw || false;
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		process.stdout.write(ENABLE_BRACKETED_PASTE);
		this.bracketedPaste.start();

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
			if (this.programStatusReporter.handleReply(sequence)) return;
			const input = this.keyboardProtocol.process(sequence);
			if (input !== undefined) this.forwardInputSequence(input);
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.stdinBuffer.on("paste", (content) => {
			if (this.inputHandler) {
				this.inputHandler(`\x1b[200~${content}\x1b[201~`);
			}
		});

		// Handler that pipes stdin data through the buffer
		this.stdinDataHandler = (data: string) => {
			this.bracketedPaste.activity();
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * Query terminal for Kitty keyboard protocol support (see KeyboardProtocol), the OSC 7501 program
	 * status support and the graphics protocol, all answered before the trailing DA sentinel.
	 */
	private queryAndEnableKittyProtocol(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		this.keyboardProtocol.beginNegotiation();
		const programStatusQuery = this.programStatusReporter.beginQuery();
		const graphicsQuery = this.graphicsProbe.start(
			Boolean(process.stdin.isTTY && process.stdout.isTTY),
			this.capabilitiesHandler,
		);
		process.stdout.write(
			`${KITTY_KEYBOARD_PROTOCOL_QUERY}${programStatusQuery}${graphicsQuery}${DEVICE_ATTRIBUTES_QUERY}`,
		);
		this.programStatusReporter.write();
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
		this.keyboardProtocol.disable();

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
		this.progress.clear();
		this.programStatusReporter.stop();

		// Disable bracketed paste mode
		this.bracketedPaste.stop();
		process.stdout.write(DISABLE_BRACKETED_PASTE);

		// Disable the keyboard protocols if drainInput() has not already done so.
		this.keyboardProtocol.disable();

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
		this.output.write(data);
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
		this.programStatusReporter.set(status);
	}

	setProgress(active: boolean): void {
		this.progress.set(active);
	}
}
