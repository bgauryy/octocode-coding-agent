import { formatBytes } from "../../utils/bytes.ts";
import { FAILURE_WORDS } from "./output-trim.ts";

/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except bash tail truncation edge case).
 */

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB

export interface TruncationResult {
	/** The truncated content */
	content: string;
	/** Whether truncation occurred */
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated */
	truncatedBy: "lines" | "bytes" | null;
	/** Total number of lines in the original content */
	totalLines: number;
	/** Total number of bytes in the original content */
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	outputLines: number;
	/** Number of bytes in the truncated output */
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied */
	maxLines: number;
	/** The max bytes limit that was applied */
	maxBytes: number;
	/** Head-and-tail truncation only: complete lines kept from the start of the output. */
	headLines?: number;
	/** Head-and-tail truncation only: bytes of those head lines. */
	headBytes?: number;
	/** Head-and-tail truncation only: lines between the head and the tail that are left out. */
	elidedLines?: number;
	/** Head-and-tail truncation only: lines at the end of the output that are shown. */
	tailLines?: number;
	/** Head-and-tail truncation only: failure lines from the elided part shown between head and tail. */
	matchedLines?: number;
}

/**
 * Share of the line and byte budget that head-and-tail truncation gives to the start of the output.
 * The first compiler or test error usually sits near the start and the final summary or exit status at
 * the end. The tail gets the larger share; one fifth of the default budget (400 lines, 10KB) still holds
 * the first error with its context.
 */
const HEAD_SHARE = 0.2;

/** Lines and bytes the head may use; the tail gets the rest of the same budget. */
export function splitHeadTailBudget(maxLines: number, maxBytes: number): { headLines: number; headBytes: number } {
	return { headLines: Math.floor(maxLines * HEAD_SHARE), headBytes: Math.floor(maxBytes * HEAD_SHARE) };
}

/**
 * The line between the kept head and the kept tail. `elidedLines` is 0 when only the start of the last
 * (very long) line is cut.
 */
export function formatElisionMarker(
	elidedLines: number,
	lastLine: number,
	fullOutputPath?: string,
	matchedLines = 0,
): string {
	const what =
		elidedLines > 0
			? `${elidedLines} ${elidedLines === 1 ? "line" : "lines"} elided`
			: `start of line ${lastLine} elided`;
	const matched =
		matchedLines > 0
			? `; ${matchedLines} ${matchedLines === 1 ? "line" : "lines"} matching ${FAILURE_WORDS} below, then the end of the output`
			: "";
	return `[... ${what}${matched}${fullOutputPath ? `; full output: ${fullOutputPath}` : ""}]`;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: 2000) */
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	maxBytes?: number;
}

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) {
		return [];
	}
	const lines = content.split("\n");
	if (content.endsWith("\n")) {
		lines.pop();
	}
	return lines;
}

/**
 * Format bytes as human-readable size.
 */
export function formatSize(bytes: number): string {
	return formatBytes(bytes, "compact");
}

/** The limits and content size, or the whole content as the result when it fits both limits. */
function measureForTruncation(
	content: string,
	options: TruncationOptions,
):
	| { untruncated: TruncationResult }
	| { maxLines: number; maxBytes: number; totalBytes: number; lines: string[]; totalLines: number } {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = Buffer.byteLength(content, "utf-8");
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;
	if (totalLines <= maxLines && totalBytes <= maxBytes) {
		return {
			untruncated: {
				content,
				truncated: false,
				truncatedBy: null,
				totalLines,
				totalBytes,
				outputLines: totalLines,
				outputBytes: totalBytes,
				lastLinePartial: false,
				firstLineExceedsLimit: false,
				maxLines,
				maxBytes,
			},
		};
	}
	return { maxLines, maxBytes, totalBytes, lines, totalLines };
}

/** The result of head or tail truncation from the kept lines; a line limit hit within the byte limit wins. */
function truncatedResult(
	measured: { maxLines: number; maxBytes: number; totalBytes: number; totalLines: number },
	outputLines: string[],
	outputBytesCount: number,
	truncatedBy: "lines" | "bytes",
	lastLinePartial: boolean,
): TruncationResult {
	const { maxLines, maxBytes, totalBytes, totalLines } = measured;
	const content = outputLines.join("\n");
	return {
		content,
		truncated: true,
		truncatedBy: outputLines.length >= maxLines && outputBytesCount <= maxBytes ? "lines" : truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLines.length,
		outputBytes: Buffer.byteLength(content, "utf-8"),
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const measured = measureForTruncation(content, options);
	if ("untruncated" in measured) return measured.untruncated;
	const { maxLines, maxBytes, totalBytes, lines, totalLines } = measured;

	// Check if first line alone exceeds byte limit
	const firstLineBytes = Buffer.byteLength(lines[0], "utf-8");
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// Collect complete lines that fit
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (i > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	return truncatedResult(measured, outputLinesArr, outputBytesCount, truncatedBy, false);
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return partial first line if the last line of original content exceeds byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const measured = measureForTruncation(content, options);
	if ("untruncated" in measured) return measured.untruncated;
	const { maxLines, maxBytes, lines } = measured;

	// Work backwards from the end
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// Edge case: if we haven't added ANY lines yet and this line exceeds maxBytes,
			// take the end of the line (partial)
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	return truncatedResult(measured, outputLinesArr, outputBytesCount, truncatedBy, lastLinePartial);
}

/**
 * Truncate a string to fit within a byte limit (from the end).
 * Handles multi-byte UTF-8 characters correctly.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// Start from the end, skip maxBytes back
	let start = buf.length - maxBytes;

	// Find a valid UTF-8 boundary (start of a character)
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}

	return buf.subarray(start).toString("utf-8");
}
