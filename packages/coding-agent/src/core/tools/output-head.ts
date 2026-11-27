import { collapseRepeats, FailureLineScanner } from "./output-trim.ts";

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * The start of a command's output: its first lines for the head of a trimmed result, and (with `smartTrim`) the
 * failure lines that come after them, found as the output streams.
 */
export class OutputHead {
	/** The start of the output, at most `maxBytes + 1` bytes; complete lines are cut out of it on demand. */
	private buffer = "";
	private bufferBytes = 0;
	private closed = false;
	/** The head as its budget fixes it before repeated lines collapse: later lines are candidates for the matched block. */
	private plainOpen = true;
	private plainLines = 0;
	private plainBytes = 0;
	readonly failures = new FailureLineScanner();

	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly smartTrim: boolean;

	constructor(maxLines: number, maxBytes: number, smartTrim: boolean) {
		this.maxLines = maxLines;
		this.maxBytes = maxBytes;
		this.smartTrim = smartTrim;
	}

	/** Takes the next decoded text, which holds `bytes` bytes. */
	capture(text: string, bytes: number): void {
		if (this.closed) return;
		const room = this.maxBytes + 1 - this.bufferBytes;
		if (bytes <= room) {
			this.buffer += text;
			this.bufferBytes += bytes;
			return;
		}
		const buffer = Buffer.from(text, "utf-8");
		let end = room;
		while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
			end--;
		}
		this.buffer += buffer.subarray(0, end).toString("utf-8");
		this.bufferBytes += end;
		this.closed = true;
	}

	/**
	 * Passes each complete line of `text` to the failure scanner unless the head shows it. `completedLines` counts the
	 * lines before `text`, and `continuesLine` says its first line began in earlier text.
	 */
	scan(text: string, completedLines: number, continuesLine: boolean): void {
		if (!this.smartTrim || (!this.plainOpen && this.failures.full)) return;
		const parts = text.split("\n");
		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			// A continued line was judged with its start; the text after the last newline is empty.
			if ((i === 0 && continuesLine) || (i === parts.length - 1 && part === "")) continue;
			if (this.plainOpen) {
				const next = this.plainBytes + byteLength(part) + (this.plainLines > 0 ? 1 : 0);
				if (this.plainLines < this.maxLines && next <= this.maxBytes) {
					this.plainLines++;
					this.plainBytes = next;
					continue;
				}
				this.plainOpen = false;
			}
			this.failures.scan(completedLines + i + 1, part);
		}
	}

	/**
	 * The first complete lines that fit the head budget, without the final newline. `lines` are the lines shown
	 * (repeats collapsed under `smartTrim`) and `covered` the output lines they stand for.
	 */
	get(): { text: string; lines: number; bytes: number; covered: number } {
		const end = this.buffer.lastIndexOf("\n");
		if (end === -1) return { text: "", lines: 0, bytes: 0, covered: 0 };
		const plain = this.buffer.slice(0, end).split("\n");
		const { lines, extras } = this.smartTrim ? collapseRepeats(plain) : { lines: plain, extras: [] as number[] };
		let count = 0;
		let bytes = 0;
		while (count < lines.length && count < this.maxLines) {
			const next = bytes + byteLength(lines[count]) + (count > 0 ? 1 : 0);
			if (next > this.maxBytes) break;
			bytes = next;
			count++;
		}
		return {
			text: lines.slice(0, count).join("\n"),
			lines: count,
			bytes,
			covered: count + extras.slice(0, count).reduce((sum, extra) => sum + extra, 0),
		};
	}
}
