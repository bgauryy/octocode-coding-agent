import type { WriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { splitIncompleteAnsiSuffix, stripAnsi } from "../../utils/ansi.ts";
import { createOutputFileStream } from "../../utils/output-files.ts";
import { OutputHead } from "./output-head.ts";
import {
	collapseCarriageReturns,
	collapseLine,
	collapseText,
	coveredLines,
	type FailureLineScanner,
	formatMatchedBlock,
} from "./output-trim.ts";
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

interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
	/**
	 * Show a run of identical lines once with a count, and, when the output is trimmed, the failure lines
	 * (`output-trim.ts`) from the elided middle under the head. The temp file keeps every line.
	 */
	smartTrim?: boolean;
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
	private readonly smartTrim: boolean;
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
	private readonly head: OutputHead;
	/** The rolling tail lost its start, so it no longer holds the whole output. */
	private tailDropped = false;

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
		this.smartTrim = options.smartTrim ?? false;
		const head = splitHeadTailBudget(this.maxLines, this.maxBytes);
		this.head = new OutputHead(head.headLines, head.headBytes, this.smartTrim);
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
		const raw = this.getSnapshotText() + this.openLine;
		const view = this.smartTrim ? collapseText(raw) : { text: raw, extras: [] };
		const limits = { maxLines: this.maxLines, maxBytes: this.maxBytes };

		// Collapsed repeats can bring output over the budget back under it: then all of it shows.
		if ((!linesExceeded && !bytesExceeded) || (this.smartTrim && !this.tailDropped)) {
			const all = truncateTail(view.text, limits);
			if (!all.truncated) {
				return {
					content: all.content,
					truncation: { ...all, totalLines, totalBytes },
					fullOutputPath: this.tempFilePath,
				};
			}
		}

		if (options.persistIfTruncated) {
			this.ensureTempFile();
		}

		const head = this.head.get();
		const budget = (spent: { lines: number; bytes: number }) => ({
			maxLines: this.maxLines - head.lines - spent.lines,
			maxBytes: this.maxBytes - head.bytes - spent.bytes,
		});
		let tail = truncateTail(view.text, budget({ lines: 0, bytes: 0 }));
		let tailCovered = coveredLines(tail.outputLines, view.extras);
		let matches: ReturnType<FailureLineScanner["between"]> = [];
		if (head.lines > 0 && this.smartTrim) {
			matches = this.head.failures.between(head.covered + 1, totalLines - tailCovered);
			if (matches.length > 0) {
				const block = formatMatchedBlock(matches);
				tail = truncateTail(view.text, budget({ lines: matches.length + 1, bytes: byteLength(block) + 1 }));
				tailCovered = coveredLines(tail.outputLines, view.extras);
			}
		}
		const elidedLines = Math.max(0, totalLines - head.covered - tailCovered);
		const marker = formatElisionMarker(
			elidedLines,
			totalLines,
			this.smartTrim ? undefined : this.tempFilePath,
			matches.length,
		);
		const matched = matches.length > 0 ? `${formatMatchedBlock(matches)}\n` : "";
		const content = head.lines > 0 ? `${head.text}\n${marker}\n${matched}${tail.content}` : tail.content;
		const matchedBytes = matched ? byteLength(matched) : 0;
		const truncation: TruncationResult = {
			...tail,
			content,
			truncated: true,
			truncatedBy: linesExceeded && bytesExceeded ? (tail.truncatedBy ?? "lines") : bytesExceeded ? "bytes" : "lines",
			totalLines,
			totalBytes,
			outputLines: head.covered + tailCovered,
			outputBytes: head.bytes + matchedBytes + tail.outputBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
			...(head.lines > 0
				? {
						headLines: head.covered,
						headBytes: head.bytes,
						elidedLines,
						tailLines: tailCovered,
						matchedLines: matches.length,
					}
				: {}),
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
		this.head.scan(text, this.completedLines, this.hasOpenLine);
		this.totalDecodedBytes += bytes;
		this.head.capture(text, bytes);
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

		this.tailDropped = true;
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
