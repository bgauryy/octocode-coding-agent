import { isNativeModifierPressed, warmNativeModifiers } from "./native-modifiers.ts";
import type { ProgramStatus } from "./program-status.ts";
import { hasTmuxSession } from "./multiplexer.ts";
import { StdinBuffer } from "./stdin-buffer.ts";
import { POP_TITLE, WindowTitle } from "./terminal/window-title.ts";
import { BracketedPasteRearm, DISABLE_BRACKETED_PASTE, ENABLE_BRACKETED_PASTE } from "./terminal/bracketed-paste.ts";
import { DEVICE_ATTRIBUTES_QUERY } from "./terminal/device-attributes.ts";
import { registerExitRestore, unregisterAfterOutput } from "./terminal/exit-restore.ts";
import {
	detectsNativeShiftEnter,
	enableWindowsVTInput,
	normalizeNativeShiftEnterInput,
	refreshTerminalDimensions,
	resolveEscapeTimeoutMs,
	resolvePasteTimeoutMs,
} from "./terminal/environment.ts";
import { KeyboardProtocol, KITTY_KEYBOARD_PROTOCOL_QUERY } from "./terminal/keyboard-protocol.ts";
import { TerminalOutput } from "./terminal/output.ts";
import { ProgramStatusReporter } from "./terminal/program-status-reporter.ts";
import { ProgressIndicator } from "./terminal/progress.ts";
import { StatusProbeWatch, waitForQuietInput } from "./terminal/status-probe-watch.ts";
import { SynchronizedOutputProbe } from "./terminal/synchronized-output.ts";
import { readTypedLines, typedAheadInput } from "./terminal/typeahead.ts";
import type { OutputKind, OutputTelemetry, Terminal } from "./terminal/types.ts";
import { KittyGraphicsProbe } from "./terminal-image/probe.ts";
import {
	CLEAR_FROM_CURSOR,
	CLEAR_LINE,
	CLEAR_SCREEN,
	HIDE_CURSOR,
	moveRowsSequence,
	SHOW_CURSOR,
} from "./terminal/cursor.ts";

export {
	isAppleTerminalSession,
	normalizeNativeShiftEnterInput,
	refreshTerminalDimensions,
	resolveEscapeTimeoutMs,
	resolvePasteTimeoutMs,
} from "./terminal/environment.ts";
export type { OutputKind, OutputTelemetry, Terminal } from "./terminal/types.ts";

/**
 * Real terminal using process.stdin/stdout
 */
export class ProcessTerminal implements Terminal {
	private readonly windowTitle = new WindowTitle();
	private readonly output = new TerminalOutput();
	private readonly statusProbes = new StatusProbeWatch();
	inputDraining = false;
	private readonly programStatusReporter = new ProgramStatusReporter();
	private readonly progress = new ProgressIndicator(() => this.output.allowsDecorativeOutput());
	private readonly graphicsProbe = new KittyGraphicsProbe();
	private readonly synchronizedOutputProbe = new SynchronizedOutputProbe();
	private readonly keyboardProtocol = new KeyboardProtocol({
		forward: (sequence) => this.forwardInputSequence(sequence),
		onLastDeviceAttributes: () => {
			this.programStatusReporter.settleQuery();
			this.synchronizedOutputProbe.settle();
			this.graphicsProbe.finish();
		},
	});
	private readonly bracketedPaste = new BracketedPasteRearm({
		isEnabled: () => hasTmuxSession(),
		write: (sequence) => process.stdout.write(sequence),
		isPasting: () => this.stdinBuffer?.pasting ?? false,
	});
	private wasRaw = false;
	private disposeExitRestore?: () => void;
	private inputHandler?: (data: string) => void;
	/** Called when the input handler throws; input keeps flowing. Default: one line on stderr. */
	onInputError: (error: unknown) => void = (error) => {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		process.stderr.write(`\r\noctocode: input handler failed: ${message.replaceAll("\n", "\r\n")}\r\n`);
	};
	private resizeHandler?: () => void;
	private capabilitiesHandler?: () => void;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;
	private nativeShiftWarmup?: NodeJS.Timeout;

	get pendingOutputBytes(): number {
		return this.output.pendingBytes;
	}

	drainOutput(maxMs?: number): Promise<boolean> {
		return this.output.drain(maxMs);
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

	get synchronizedOutput(): boolean {
		return this.synchronizedOutputProbe.supported;
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
		// A child that held the terminal since the last start() left stdout blocking.
		this.output.useNonblockingWrites();

		// Save previous state and enable raw mode; lines typed in line mode before it are taken first.
		this.wasRaw = process.stdin.isRaw || false;
		const typedAhead = this.wasRaw ? "" : typedAheadInput(readTypedLines());
		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(true);
		}
		process.stdin.setEncoding("utf8");
		process.stdin.resume();

		// Enable bracketed paste mode - terminal will wrap pastes in \x1b[200~ ... \x1b[201~
		process.stdout.write(ENABLE_BRACKETED_PASTE + this.windowTitle.push());
		this.bracketedPaste.start();
		this.disposeExitRestore?.();
		this.disposeExitRestore = registerExitRestore(() => this.restoreOnExit());

		// Set up resize handler immediately
		process.stdout.on("resize", this.resizeHandler);

		// Refresh terminal dimensions - they may be stale after suspend/resume
		// (SIGWINCH is lost while process is stopped). Unix only, best-effort.
		refreshTerminalDimensions();

		// On Windows, enable ENABLE_VIRTUAL_TERMINAL_INPUT so the console sends
		// VT escape sequences (e.g. \x1b[Z for Shift+Tab) instead of raw console
		// events that lose modifier information. Must run AFTER setRawMode(true)
		// since that resets console mode flags.
		enableWindowsVTInput();

		// Query Kitty keyboard protocol and fall back to modifyOtherKeys when DA confirms no Kitty response.
		this.queryAndEnableKittyProtocol();
		// After the caller's start finished, ahead of any raw key: typed earlier, so read first.
		if (typedAhead) queueMicrotask(() => this.stdinBuffer?.process(typedAhead));

		// Load the native Shift check after start-up work instead of on the first Enter.
		if (detectsNativeShiftEnter()) this.nativeShiftWarmup = setTimeout(warmNativeModifiers, 0).unref();
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

		this.stdinBuffer.on("data", (sequence) => {
			this.statusProbes.noteInput(sequence);
			if (this.graphicsProbe.consume(sequence)) return;
			if (this.programStatusReporter.handleReply(sequence)) return;
			if (this.synchronizedOutputProbe.handleReply(sequence)) return;
			const input = this.keyboardProtocol.process(sequence);
			if (input !== undefined) this.forwardInputSequence(input);
		});

		// Re-wrap paste content with bracketed paste markers for existing editor handling
		this.stdinBuffer.on("paste", (content) => {
			this.dispatchInput(`\x1b[200~${content}\x1b[201~`);
		});

		// Handler that pipes stdin data through the buffer
		this.stdinDataHandler = (data: string) => {
			this.bracketedPaste.activity();
			this.stdinBuffer!.process(data);
		};
	}

	/**
	 * Query terminal for Kitty keyboard protocol support (see KeyboardProtocol), the OSC 7501 program
	 * status support, synchronized output (DECRQM 2026) and the graphics protocol, all answered before the trailing DA
	 * sentinel.
	 */
	private queryAndEnableKittyProtocol(): void {
		this.setupStdinBuffer();
		process.stdin.on("data", this.stdinDataHandler!);
		this.keyboardProtocol.beginNegotiation();
		const programStatusQuery = this.programStatusReporter.beginQuery();
		const synchronizedOutputQuery = this.synchronizedOutputProbe.beginQuery();
		const graphicsQuery = this.graphicsProbe.start(
			// oxlint-disable-next-line typescript/no-unnecessary-type-conversion -- `isTTY` is typed boolean but is undefined on a stream that is not a terminal
			Boolean(process.stdin.isTTY && process.stdout.isTTY),
			this.capabilitiesHandler,
		);
		process.stdout.write(
			`${KITTY_KEYBOARD_PROTOCOL_QUERY}${programStatusQuery}${synchronizedOutputQuery}${graphicsQuery}${DEVICE_ATTRIBUTES_QUERY}`,
		);
		this.programStatusReporter.write();
	}

	private dispatchInput(input: string): void {
		if (!this.inputHandler) return;
		try {
			this.inputHandler(input);
		} catch (error) {
			try {
				this.onInputError(error);
			} catch {
				// A failing reporter must not take input down with it.
			}
		}
	}

	private forwardInputSequence(sequence: string): void {
		if (!this.inputHandler) return;
		const shouldDetectNativeShiftEnter = sequence === "\r" && detectsNativeShiftEnter();
		const input = normalizeNativeShiftEnterInput(
			sequence,
			shouldDetectNativeShiftEnter,
			shouldDetectNativeShiftEnter && isNativeModifierPressed("shift"),
		);
		this.dispatchInput(input);
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
		this.inputDraining = true;
		try {
			await waitForQuietInput({ maxMs, idleMs, lastDataAt: () => lastDataTime, watch: this.statusProbes });
		} finally {
			this.inputDraining = false;
			process.stdin.removeListener("data", onData);
			this.inputHandler = previousHandler;
		}
	}

	/** Undo the modes start() turned on when the process ends without stop(): the same synchronous writes stop() makes. */
	private restoreOnExit(): void {
		const write = (data: string) => this.output.writeOnExit(data);
		this.progress.clear(write, true);
		this.programStatusReporter.restoreOnExit(write);
		this.keyboardProtocol.restoreOnExit(write);
		write(`${DISABLE_BRACKETED_PASTE}\x1b[?25h${POP_TITLE}`);
	}

	stop(): void {
		clearTimeout(this.nativeShiftWarmup);
		this.graphicsProbe.stop();
		this.capabilitiesHandler = undefined;
		this.progress.clear();
		this.programStatusReporter.stop();
		this.synchronizedOutputProbe.stop();

		this.bracketedPaste.stop();
		process.stdout.write(DISABLE_BRACKETED_PASTE);
		process.stdout.write(this.windowTitle.pop());

		// Disable the keyboard protocols if drainInput() has not already done so.
		this.keyboardProtocol.disable();

		if (this.stdinBuffer) {
			this.stdinBuffer.destroy();
			this.stdinBuffer = undefined;
		}

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

		if (process.stdin.setRawMode) {
			process.stdin.setRawMode(this.wasRaw);
		}
		if (this.disposeExitRestore) unregisterAfterOutput(this, this.disposeExitRestore);
		this.disposeExitRestore = undefined;
	}

	write(data: string, kind?: OutputKind): void {
		this.statusProbes.noteWrite(data);
		this.output.write(data, kind);
	}

	setFrameOutputCap(bytes: number | undefined): void {
		this.output.setFrameCap(bytes);
	}

	get frameOutputCap(): number | undefined {
		return this.output.frameCap;
	}

	setOutputRecovery(recover: (() => void) | undefined): void {
		this.output.setRecovery(recover);
	}

	writeOnExit(data: string): void {
		this.output.writeOnExit(data);
	}

	get columns(): number {
		return process.stdout.columns || Number(process.env.COLUMNS) || 80;
	}

	get rows(): number {
		return process.stdout.rows || Number(process.env.LINES) || 24;
	}

	// Cursor and clear sequences go through the output queue, so they land after the frames written before them.
	moveBy(lines: number): void {
		const sequence = moveRowsSequence(lines);
		if (sequence) this.output.write(sequence);
	}

	hideCursor(): void {
		this.output.write(HIDE_CURSOR);
	}

	showCursor(): void {
		this.output.write(SHOW_CURSOR);
	}

	clearLine(): void {
		this.output.write(CLEAR_LINE);
	}

	clearFromCursor(): void {
		this.output.write(CLEAR_FROM_CURSOR);
	}

	clearScreen(): void {
		this.output.write(CLEAR_SCREEN);
	}

	setTitle(title: string): void {
		process.stdout.write(this.windowTitle.set(title));
	}

	setProgramStatus(status: ProgramStatus): void {
		this.programStatusReporter.set(status);
	}

	setProgress(active: boolean): void {
		this.progress.set(active);
	}
}
