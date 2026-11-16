import { StringDecoder } from "node:string_decoder";

/**
 * Splits a byte stream into newline-delimited lines of at most `maxBytes`. A longer line (or one that never ends)
 * calls `onOverflow` once and stops the reader; the owner closes the socket.
 */
export class LineReader {
	private buffer = "";
	private pending = 0;
	private stopped = false;
	/** Keeps the bytes of a multi-byte character that a chunk boundary cut, until its rest arrives. */
	private readonly decoder = new StringDecoder("utf8");
	private readonly maxBytes: number;
	private readonly onLine: (line: string) => void;
	private readonly onOverflow: () => void;

	constructor(maxBytes: number, onLine: (line: string) => void, onOverflow: () => void) {
		this.maxBytes = maxBytes;
		this.onLine = onLine;
		this.onOverflow = onOverflow;
	}

	push(chunk: Buffer | string): void {
		if (this.stopped) return;
		const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		let start = 0;
		for (;;) {
			const end = text.indexOf("\n", start);
			if (end < 0) break;
			const line = this.buffer + text.slice(start, end);
			this.buffer = "";
			this.pending = 0;
			start = end + 1;
			if (Buffer.byteLength(line) > this.maxBytes) return this.stop();
			if (line.trim()) this.onLine(line);
			if (this.stopped) return;
		}
		const rest = text.slice(start);
		this.pending += Buffer.byteLength(rest);
		this.buffer += rest;
		if (this.pending > this.maxBytes) this.stop();
	}

	private stop(): void {
		this.stopped = true;
		this.buffer = "";
		this.onOverflow();
	}
}
