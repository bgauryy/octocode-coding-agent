import * as fs from "node:fs";
import { resolveWriteLogPath } from "./environment.ts";
import { type OutputStallReport, type OutputStallWatch, stallWatchFor } from "./stall-watch.ts";
import type { OutputKind, OutputTelemetry } from "./types.ts";

/**
 * Longest the exit restore writes together wait for a terminal that has stopped reading (a hidden or paused pane).
 * Past it the remaining restore bytes are dropped: a quit that never ends is worse than modes left on.
 */
const EXIT_WRITE_BUDGET_MS = 1000;
/** Set by the first exit write that finds the terminal full; every later exit write shares it. */
let exitWriteDeadline: number | undefined;

function pause(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function emptyTelemetry(): OutputTelemetry {
	return {
		writtenBytes: 0,
		writeCalls: 0,
		maxWriteBytes: 0,
		backpressuredWrites: 0,
		maxQueuedBytes: 0,
		droppedFrameBytes: 0,
	};
}

/** Node makes POSIX TTY writes blocking by default; libuv must queue them so input and health timers can run. */
export function setTerminalOutputBlocking(blocking: boolean): void {
	if (!process.stdout.isTTY || process.platform === "win32") return;
	const stream = process.stdout as NodeJS.WriteStream & { _handle?: { setBlocking?: (value: boolean) => void } };
	stream._handle?.setBlocking?.(blocking);
}

/**
 * Queued bytes past which a frame is dropped instead of queued, by default: the render loop's output gate holds
 * scheduled frames at 256 KiB, so only frames painted around the gate (input, resize) can reach it. Measured on an owned
 * PTY that stopped reading; Terminal.app's queue peaked at 13 KB in normal use.
 */
const DEFAULT_FRAME_OUTPUT_CAP = 512 * 1024;
/** UTF-8 encodes one UTF-16 code unit in at most three bytes. */
const MAX_UTF8_BYTES_PER_UNIT = 3;

/**
 * Rendered output to stdout: reports the queue so the render loop can gate frames on it, counts
 * bytes when telemetry is on, and copies output to the write log when `OCTOCODE_TUI_WRITE_LOG` is set.
 *
 * A terminal that stops reading (a paused tmux pane, a stalled SSH link) would otherwise collect every frame painted in
 * the meantime. A frame only replaces the one before it, so once the queue passes the frame cap new frames are dropped,
 * never mode, restore, status or scrollback bytes (`essential`, the default). When the queue drains after a drop, the
 * recovery callback repaints the screen whole.
 *
 * Queued bytes that wait more than a few seconds open a stall episode (see `OutputStallWatch`): the telemetry reports
 * it even with counters off, and decoration such as progress keepalives waits until the terminal reads again.
 */
export class TerminalOutput {
	private readonly stream: typeof process.stdout;
	private readonly stalls: OutputStallWatch;
	private frameCapBytes: number | undefined = DEFAULT_FRAME_OUTPUT_CAP;
	private framesDropped = false;
	private awaitingDrain = false;
	private recover: (() => void) | undefined;
	private decorativePressureThreshold: number | undefined;
	private telemetryEnabled = false;
	private telemetry: OutputTelemetry = emptyTelemetry();
	private readonly writeLogPath = resolveWriteLogPath();
	private readonly drains = new Set<(drained: boolean) => void>();
	private readonly failDrains = () => {
		for (const finish of this.drains) finish(false);
	};

	/** @param stream Where output goes; another stream than stdout is for tests and keeps its blocking mode. */
	constructor(stream: typeof process.stdout = process.stdout) {
		this.stream = stream;
		this.stalls = stallWatchFor(stream);
		if (stream === process.stdout) this.useNonblockingWrites();
	}

	/**
	 * Make stdout writes queue instead of block. Call again whenever the terminal is taken back from a child that
	 * inherited stdout (an external editor, a sign-in CLI): libuv clears O_NONBLOCK on an inherited stdio descriptor,
	 * and the flag belongs to the open file this process shares with the child.
	 */
	useNonblockingWrites(): void {
		setTerminalOutputBlocking(false);
	}

	get pendingBytes(): number {
		return this.stream.writableLength;
	}

	/** The terminal's stalls so far; undefined when it never stopped reading. */
	get stall(): OutputStallReport | undefined {
		return this.stalls.report();
	}

	/** Wait for queued bytes before an explicit exit, with a deadline for a disconnected or paused consumer. */
	drain(maxMs = 1000): Promise<boolean> {
		if (this.pendingBytes === 0) return Promise.resolve(true);
		return new Promise((resolve) => {
			let settled = false;
			const finish = (drained: boolean): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.drains.delete(finish);
				if (this.drains.size === 0) this.stream.off("error", this.failDrains);
				resolve(drained);
			};
			const timer = maxMs === Infinity ? undefined : setTimeout(() => finish(false), maxMs);
			if (this.drains.size === 0) this.stream.on("error", this.failDrains);
			this.drains.add(finish);
			try {
				this.stream.write("", (error) => finish(!error));
			} catch {
				finish(false);
			}
		});
	}

	get frameCap(): number | undefined {
		return this.frameCapBytes;
	}

	/** Queued bytes past which frames are dropped; undefined keeps every frame. */
	setFrameCap(bytes: number | undefined): void {
		this.frameCapBytes = bytes !== undefined && Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : undefined;
	}

	/** What repaints the screen whole once the queue drains after frames were dropped. */
	setRecovery(recover: (() => void) | undefined): void {
		this.recover = recover;
	}

	setDecorativePressureThreshold(bytes: number | undefined): void {
		this.decorativePressureThreshold = bytes;
	}

	/** Whether decorative output, such as progress keepalives, may be written given the queued bytes and any stall. */
	allowsDecorativeOutput(): boolean {
		if (!this.stalls.acceptsDecoration()) return false;
		return this.decorativePressureThreshold === undefined || this.pendingBytes <= this.decorativePressureThreshold;
	}

	setTelemetryEnabled(enabled: boolean): void {
		if (enabled && !this.telemetryEnabled) {
			this.telemetry = emptyTelemetry();
		}
		this.telemetryEnabled = enabled;
	}

	getTelemetry(): Readonly<OutputTelemetry> {
		const stalls = this.stalls.report();
		return stalls ? { ...this.telemetry, stalls } : { ...this.telemetry };
	}

	/**
	 * The exit event cannot drain stdout's JavaScript queue, so restore bytes go straight to the descriptor. It stays
	 * nonblocking: a full terminal is retried until `EXIT_WRITE_BUDGET_MS`, then the rest of the bytes are dropped. A
	 * terminal that hung up (EIO) or went away takes nothing more: the bytes are dropped, never thrown at the exit.
	 */
	writeOnExit(data: string): void {
		if (!this.stream.isTTY) return this.write(data);
		const bytes = Buffer.from(data);
		let offset = 0;
		while (offset < bytes.length) {
			try {
				offset += fs.writeSync(this.stream.fd, bytes, offset, bytes.length - offset);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EAGAIN") return;
				exitWriteDeadline ??= Date.now() + EXIT_WRITE_BUDGET_MS;
				if (Date.now() >= exitWriteDeadline) return;
				pause(5);
			}
		}
	}

	write(data: string, kind: OutputKind = "essential"): void {
		if (kind === "frame" && this.frameCapBytes !== undefined) {
			const pending = this.pendingBytes;
			// One indivisible frame can exceed the cap even after budgeting images (e.g. a very large text viewport).
			// An empty queue can accept it once. Further frames wait for real drain before recovery.
			if (pending > 0 && pending + data.length * MAX_UTF8_BYTES_PER_UNIT > this.frameCapBytes) {
				const bytes = Buffer.byteLength(data);
				if (pending + bytes > this.frameCapBytes) return this.dropFrame(bytes);
			}
		}
		const accepted = this.stream.write(data);
		// Essential bytes are measured only during a stall, which is when their growth matters.
		this.stalls.noteWrite(kind, kind === "essential" && this.stalls.stalled ? Buffer.byteLength(data) : 0);
		if (this.telemetryEnabled) {
			const bytes = Buffer.byteLength(data);
			this.telemetry.writtenBytes += bytes;
			this.telemetry.writeCalls++;
			this.telemetry.maxWriteBytes = Math.max(this.telemetry.maxWriteBytes, bytes);
			if (!accepted) this.telemetry.backpressuredWrites++;
			this.telemetry.maxQueuedBytes = Math.max(this.telemetry.maxQueuedBytes, this.pendingBytes);
		}
		if (this.writeLogPath) {
			try {
				fs.appendFileSync(this.writeLogPath, data, { encoding: "utf8" });
			} catch {
				// Ignore logging errors
			}
		}
	}

	/** Count a dropped frame and repaint once everything queued before it has reached the terminal. */
	private dropFrame(bytes: number): void {
		this.telemetry.droppedFrameBytes += bytes;
		this.stalls.noteWrite("dropped", bytes);
		this.framesDropped = true;
		if (this.awaitingDrain) return;
		this.awaitingDrain = true;
		// An empty write's callback runs once every byte queued before it has been written.
		this.stream.write("", () => {
			this.awaitingDrain = false;
			if (!this.framesDropped) return;
			this.framesDropped = false;
			this.recover?.();
		});
	}
}
