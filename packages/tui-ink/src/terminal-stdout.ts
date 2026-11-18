import { Writable } from "node:stream";
import type { Terminal } from "@octocodeai/octocode-tui";

/** Write counters of one Ink host, for the perf gate and diagnostics. */
export interface StdoutCounters {
	writes: number;
	bytes: number;
}

/**
 * The stream Ink renders to. Every write goes through the terminal's own output queue (nonblocking writes, exit budget,
 * telemetry), so Ink never touches `process.stdout`. Ink reads `columns`, `rows` and `isTTY` here and listens for
 * `resize`, which `resized()` emits.
 */
export class TerminalStdout extends Writable {
	readonly isTTY = true;
	readonly counters: StdoutCounters = { writes: 0, bytes: 0 };

	private readonly terminal: Terminal;

	constructor(terminal: Terminal) {
		super({ decodeStrings: false });
		this.terminal = terminal;
	}

	get columns(): number {
		return this.terminal.columns;
	}

	get rows(): number {
		return this.terminal.rows;
	}

	override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
		this.counters.writes += 1;
		this.counters.bytes += Buffer.byteLength(text);
		// Ink diffs against what it wrote before, so a dropped frame would leave the screen out of step: always essential.
		this.terminal.write(text);
		callback();
	}

	resized(): void {
		this.emit("resize");
	}
}
