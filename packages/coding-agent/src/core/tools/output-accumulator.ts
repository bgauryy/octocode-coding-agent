import type { WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { splitIncompleteAnsiSuffix, stripAnsi } from "../../utils/ansi.ts";
import { createOutputFileStream } from "../../utils/output-files.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatElisionMarker,
	splitHeadTailBudget,
	type TruncationResult,
	truncateTail,
} from "./truncate.ts";

/** A line without a newline or carriage return that grows past this is counted before it ends. */
const OPEN_LINE_CAP_BYTES = 64 * 1024;

/** What a terminal shows after carriage-return redraws of one line: its last non-empty rewrite. */
function collapseLine(line: string): string {
	if (!line.includes("\r")) return line;
	const parts = line.split("\r");
	for (let i = parts.length - 1; i >= 0; i--) {
		if (parts[i]) return parts[i];
	}
	return "";
}

/** `collapseLine` for each line of terminated text; CRLF is a newline. */
function collapseCarriageReturns(text: string): string {
	if (!text.includes("\r")) return text;
	return text.split("\n").map(collapseLine).join("\n");
}

interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
}

interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

interface FullOutput {
	content: string;
	/** Whether `content` omits part of the output. */
	truncated: boolean;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps a fixed-size head
 * and a rolling decoded tail for display snapshots, and opens a temp file when
 * the full output needs to be preserved. A truncated snapshot shows the first
 * lines, an elision marker and the last lines (see `HEAD_SHARE`). Snapshots, line
 * and byte counts leave out terminal escape sequences (colors, cursor moves, a
 * full-screen program's redraws) and keep only the final state of a line that was
 * rewritten with carriage returns (progress bars), which only cost the model
 * tokens; the temp file and `readFullOutput` keep the raw bytes.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();
	/** An escape sequence cut by a chunk boundary, completed by the next chunk. */
	private pendingAnsi = "";
	/**
	 * The current unterminated line, collapsed to its last carriage-return rewrite. It is counted and
	 * stored in the tail only once it ends, so a later `\r` can still replace it.
	 */
	private openLine = "";
	private openBytes = 0;
	/** The raw line ended with `\r`: the next text replaces `openLine`, unless it is `\n` (CRLF). */
	private openLineCr = false;
	private readonly headMaxLines: number;
	private readonly headMaxBytes: number;
	/** The start of the output, at most `headMaxBytes + 1` bytes; complete lines are cut out of it on demand. */
	private headBuffer = "";
	private headBufferBytes = 0;
	private headClosed = false;

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;
	private closeOutputFile: (() => Promise<void>) | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "octocode-output";
		const head = splitHeadTailBudget(this.maxLines, this.maxBytes);
		this.headMaxLines = head.headLines;
		this.headMaxBytes = head.headBytes;
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendText(this.withoutAnsi(this.decoder.decode(data, { stream: true })));

		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.tempFileStream?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendText(this.withoutAnsi(this.decoder.decode(), true));
		if (this.openLine) this.appendDecodedText(this.openLine);
		this.openLine = "";
		this.openBytes = 0;
		this.openLineCr = false;
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const totalLines = this.countLines();
		const totalBytes = this.totalDecodedBytes + this.openBytes;
		const linesExceeded = totalLines > this.maxLines;
		const bytesExceeded = totalBytes > this.maxBytes;
		const text = this.getSnapshotText() + this.openLine;

		if (!linesExceeded && !bytesExceeded) {
			const whole = truncateTail(text, { maxLines: this.maxLines, maxBytes: this.maxBytes });
			return {
				content: whole.content,
				truncation: { ...whole, totalLines, totalBytes },
				fullOutputPath: this.tempFilePath,
			};
		}

		if (options.persistIfTruncated) {
			this.ensureTempFile();
		}

		const head = this.getHead();
		const tail = truncateTail(text, {
			maxLines: this.maxLines - head.lines,
			maxBytes: this.maxBytes - head.bytes,
		});
		const elidedLines = Math.max(0, totalLines - head.lines - tail.outputLines);
		const content =
			head.lines > 0
				? `${head.text}\n${formatElisionMarker(elidedLines, totalLines, this.tempFilePath)}\n${tail.content}`
				: tail.content;
		const truncation: TruncationResult = {
			...tail,
			content,
			truncated: true,
			truncatedBy: linesExceeded && bytesExceeded ? (tail.truncatedBy ?? "lines") : bytesExceeded ? "bytes" : "lines",
			totalLines,
			totalBytes,
			outputLines: head.lines + tail.outputLines,
			outputBytes: head.bytes + tail.outputBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
			...(head.lines > 0 ? { headLines: head.lines, headBytes: head.bytes, elidedLines } : {}),
		};
		return { content, truncation, fullOutputPath: this.tempFilePath };
	}

	async closeTempFile(): Promise<void> {
		await this.closeOutputFile?.();
		this.tempFileStream = undefined;
	}

	/**
	 * The complete output, for callers that can take more than the display snapshot. Call after
	 * `finish()` and `closeTempFile()`. Output longer than `maxBytes` raw bytes keeps its first and
	 * last `maxBytes / 2` bytes around an omission marker.
	 */
	async readFullOutput(maxBytes: number): Promise<FullOutput> {
		if (!this.tempFilePath) {
			return { content: new TextDecoder().decode(Buffer.concat(this.rawChunks)), truncated: false };
		}
		const file = await open(this.tempFilePath, "r");
		try {
			const size = (await file.stat()).size;
			if (size <= maxBytes) {
				return { content: new TextDecoder().decode(await file.readFile()), truncated: false };
			}
			const headBytes = Math.floor(maxBytes / 2);
			const tailBytes = maxBytes - headBytes;
			const head = Buffer.alloc(headBytes);
			const tail = Buffer.alloc(tailBytes);
			await file.read(head, 0, headBytes, 0);
			await file.read(tail, 0, tailBytes, size - tailBytes);
			// Cut at character boundaries: streaming decode holds back an incomplete trailing sequence,
			// and the tail skips leading continuation bytes.
			const headText = new TextDecoder().decode(head, { stream: true });
			let tailStart = 0;
			while (tailStart < tail.length && (tail[tailStart] & 0xc0) === 0x80) tailStart++;
			const tailText = new TextDecoder().decode(tail.subarray(tailStart));
			const omitted = size - headBytes - tailBytes;
			return { content: `${headText}\n\n[... ${omitted} bytes omitted ...]\n\n${tailText}`, truncated: true };
		} finally {
			await file.close();
		}
	}

	getLastLineBytes(): number {
		return this.currentLineBytes + this.openBytes;
	}

	private withoutAnsi(text: string, final = false): string {
		const joined = this.pendingAnsi + text;
		if (final) {
			this.pendingAnsi = "";
			return stripAnsi(joined);
		}
		const { complete, pending } = splitIncompleteAnsiSuffix(joined);
		this.pendingAnsi = pending;
		return stripAnsi(complete);
	}

	/**
	 * Takes text that has no terminal escapes. Complete lines are counted and stored right away, with each
	 * line collapsed to its last carriage-return rewrite; the unterminated end is held back in `openLine`.
	 */
	private appendText(text: string): void {
		if (text.length === 0) {
			return;
		}
		if (this.openLineCr && text[0] !== "\n" && text[0] !== "\r") {
			this.openLine = "";
		}
		let raw = this.openLine + text;
		const lastNewline = raw.lastIndexOf("\n");
		if (lastNewline !== -1) {
			this.appendDecodedText(collapseCarriageReturns(raw.slice(0, lastNewline + 1)));
			raw = raw.slice(lastNewline + 1);
		}
		this.openLineCr = raw.endsWith("\r");
		this.openLine = collapseLine(raw);
		this.openBytes = byteLength(this.openLine);
		if (!this.openLineCr && this.openBytes > OPEN_LINE_CAP_BYTES) {
			this.appendDecodedText(this.openLine);
			this.openLine = "";
			this.openBytes = 0;
		}
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		if (!this.headClosed) {
			this.captureHead(text, bytes);
		}
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
	}

	private countLines(): number {
		return this.completedLines + (this.hasOpenLine || this.openLine.length > 0 ? 1 : 0);
	}

	private captureHead(text: string, bytes: number): void {
		const room = this.headMaxBytes + 1 - this.headBufferBytes;
		if (bytes <= room) {
			this.headBuffer += text;
			this.headBufferBytes += bytes;
			return;
		}
		const buffer = Buffer.from(text, "utf-8");
		let end = room;
		while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
			end--;
		}
		this.headBuffer += buffer.subarray(0, end).toString("utf-8");
		this.headBufferBytes += end;
		this.headClosed = true;
	}

	/** The first complete lines that fit the head budget, without the final newline. */
	private getHead(): { text: string; lines: number; bytes: number } {
		let lines = 0;
		let bytes = 0;
		let end = 0;
		for (let pos = 0; lines < this.headMaxLines;) {
			const newline = this.headBuffer.indexOf("\n", pos);
			if (newline === -1) break;
			const next = bytes + byteLength(this.headBuffer.slice(pos, newline)) + (lines > 0 ? 1 : 0);
			if (next > this.headMaxBytes) break;
			bytes = next;
			lines++;
			end = newline;
			pos = newline + 1;
		}
		return { text: this.headBuffer.slice(0, end), lines, bytes };
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes ||
			this.totalDecodedBytes + this.openBytes > this.maxBytes ||
			this.countLines() > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) {
			return;
		}
		const { path, stream, close } = createOutputFileStream(this.tempFilePrefix, ".log");
		this.tempFilePath = path;
		this.tempFileStream = stream;
		this.closeOutputFile = close;
		for (const chunk of this.rawChunks) {
			this.tempFileStream.write(chunk);
		}
		this.rawChunks = [];
	}
}
