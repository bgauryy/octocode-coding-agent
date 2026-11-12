import { ansiCodeLength, extractAnsiCode } from "./ansi-codes.ts";
import { getActiveOsc8Close } from "./ansi-tracker.ts";
import { graphemeSegmenter, graphemeWidth, isPrintableAscii, visibleWidth } from "./width.ts";

function truncateFragmentToWidth(text: string, maxWidth: number): { text: string; width: number } {
	if (maxWidth <= 0 || text.length === 0) {
		return { text: "", width: 0 };
	}

	if (isPrintableAscii(text)) {
		const clipped = text.slice(0, maxWidth);
		return { text: clipped, width: clipped.length };
	}

	const hasAnsi = text.includes("\x1b");
	const hasTabs = text.includes("\t");
	if (!hasAnsi && !hasTabs) {
		let result = "";
		let width = 0;
		for (const { segment } of graphemeSegmenter.segment(text)) {
			const w = graphemeWidth(segment);
			if (width + w > maxWidth) {
				break;
			}
			result += segment;
			width += w;
		}
		return { text: result, width };
	}

	let result = "";
	let width = 0;
	let i = 0;
	let pendingAnsi = "";

	while (i < text.length) {
		const ansi = extractAnsiCode(text, i);
		if (ansi) {
			pendingAnsi += ansi.code;
			i += ansi.length;
			continue;
		}

		if (text[i] === "\t") {
			if (width + 3 > maxWidth) {
				break;
			}
			if (pendingAnsi) {
				result += pendingAnsi;
				pendingAnsi = "";
			}
			result += "\t";
			width += 3;
			i++;
			continue;
		}

		const end = plainRunEnd(text, i);
		for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
			const w = graphemeWidth(segment);
			if (width + w > maxWidth) {
				return { text: result, width };
			}
			if (pendingAnsi) {
				result += pendingAnsi;
				pendingAnsi = "";
			}
			result += segment;
			width += w;
		}
		i = end;
	}

	return { text: result, width };
}

function isPrintableAsciiCode(code: number): boolean {
	return code >= 0x20 && code <= 0x7e;
}

/** Printable ASCII characters that end a segmenter run when they all follow it. */
const ASCII_STRETCH = 8;

/** Whether `ASCII_STRETCH` printable ASCII characters (or the rest of the text) start at `start`. */
function asciiStretch(text: string, start: number): boolean {
	const end = Math.min(text.length, start + ASCII_STRETCH);
	for (let i = start; i < end; i++) if (!isPrintableAsciiCode(text.charCodeAt(i))) return false;
	return true;
}

/** Whether the first `length` characters of `text` (all of it when shorter) are printable ASCII. */
function isPrintableAsciiPrefix(text: string, length: number): boolean {
	const end = Math.min(text.length, length);
	for (let i = 0; i < end; i++) if (!isPrintableAsciiCode(text.charCodeAt(i))) return false;
	return true;
}

/** End of the run starting at `start` that contains no tab or ANSI sequence. */
function plainRunEnd(text: string, start: number): number {
	let end = start;
	while (end < text.length && text[end] !== "\t" && !extractAnsiCode(text, end)) end++;
	return end;
}

function finalizeTruncatedResult(
	prefix: string,
	prefixWidth: number,
	ellipsis: string,
	ellipsisWidth: number,
	maxWidth: number,
	pad: boolean,
): string {
	const reset = "\x1b[0m";
	const hyperlinkClose = getActiveOsc8Close(prefix);
	const visibleWidth = prefixWidth + ellipsisWidth;
	let result: string;

	if (ellipsis.length > 0) {
		result = `${prefix}${hyperlinkClose}${reset}${ellipsis}${reset}`;
	} else {
		result = `${prefix}${hyperlinkClose}${reset}`;
	}

	return pad ? result + " ".repeat(Math.max(0, maxWidth - visibleWidth)) : result;
}

/**
 * Truncate text to fit within a maximum visible width, adding ellipsis if needed.
 * Optionally pad with spaces to reach exactly maxWidth.
 * Properly handles ANSI escape codes (they don't count toward width).
 *
 * @param text - Text to truncate (may contain ANSI codes)
 * @param maxWidth - Maximum visible width
 * @param ellipsis - Ellipsis string to append when truncating (default: "…")
 * @param pad - If true, pad result with spaces to exactly maxWidth (default: false)
 * @returns Truncated text, optionally padded to exactly maxWidth
 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis: string = "…", pad: boolean = false): string {
	if (maxWidth <= 0) {
		return "";
	}

	if (text.length === 0) {
		return pad ? " ".repeat(maxWidth) : "";
	}

	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= maxWidth) {
		const textWidth = visibleWidth(text);
		if (textWidth <= maxWidth) {
			return pad ? text + " ".repeat(maxWidth - textWidth) : text;
		}

		const clippedEllipsis = truncateFragmentToWidth(ellipsis, maxWidth);
		if (clippedEllipsis.width === 0) {
			return pad ? " ".repeat(maxWidth) : "";
		}
		return finalizeTruncatedResult("", 0, clippedEllipsis.text, clippedEllipsis.width, maxWidth, pad);
	}

	// Printable ASCII is one cell per character: when the first `maxWidth + 1` characters are, the rest cannot change
	// the result, so a long plain line is not scanned to its end.
	if (isPrintableAsciiPrefix(text, maxWidth + 1)) {
		if (text.length <= maxWidth) {
			return pad ? text + " ".repeat(maxWidth - text.length) : text;
		}
		const targetWidth = maxWidth - ellipsisWidth;
		return finalizeTruncatedResult(text.slice(0, targetWidth), targetWidth, ellipsis, ellipsisWidth, maxWidth, pad);
	}

	const targetWidth = maxWidth - ellipsisWidth;
	let result = "";
	let pendingAnsi = "";
	let visibleSoFar = 0;
	let keptWidth = 0;
	let keepContiguousPrefix = true;
	let overflowed = false;
	// Count a cell that may join the kept prefix; false once the text passed `maxWidth`.
	const take = (segment: string, width: number): boolean => {
		if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
			result += pendingAnsi + segment;
			pendingAnsi = "";
			keptWidth += width;
		} else {
			keepContiguousPrefix = false;
			pendingAnsi = "";
		}
		visibleSoFar += width;
		overflowed = visibleSoFar > maxWidth;
		return !overflowed;
	};

	// One pass that stops where the text overflows: a styled row of tool output can be thousands of characters long and
	// only its first `maxWidth` cells matter. Printable ASCII is one cell per character and is taken in runs; anything
	// else goes through the grapheme segmenter.
	let i = 0;
	while (i < text.length && !overflowed) {
		const code = text.charCodeAt(i);
		if (code === 0x1b) {
			const length = ansiCodeLength(text, i);
			if (length > 0) {
				pendingAnsi += text.substring(i, i + length);
				i += length;
				continue;
			}
		}
		if (code === 0x09) {
			take("\t", 3);
			i++;
			continue;
		}
		// Past `maxWidth - visibleSoFar + 1` more cells the text overflows, so a run is not scanned further.
		const limit = Math.min(text.length, i + maxWidth - visibleSoFar + 1);
		let end = i;
		while (end < limit && isPrintableAsciiCode(text.charCodeAt(end))) end++;
		// The last ASCII character before other text may begin a cluster with it (a letter and a combining mark).
		if (end > i && end < text.length && text.charCodeAt(end) >= 0x80) end--;
		if (end > i) {
			const count = end - i;
			const keep = keepContiguousPrefix ? Math.max(0, Math.min(count, targetWidth - keptWidth)) : 0;
			if (keep > 0) {
				result += pendingAnsi + text.slice(i, i + keep);
				pendingAnsi = "";
				keptWidth += keep;
			}
			if (keep < count) {
				keepContiguousPrefix = false;
				pendingAnsi = "";
			}
			visibleSoFar += count;
			overflowed = visibleSoFar > maxWidth;
			i = end;
			continue;
		}
		// Other text is segmented up to the next escape sequence, tab or stretch of plain ASCII: short ASCII gaps (accented
		// words) stay in one segmenter pass, which costs less than one per word, while a glyph before a long ASCII line
		// (a tool row's gutter) hands the line back to the fast path. A run ends only before printable ASCII, which always
		// starts a new cluster.
		end = i + 1;
		while (end < text.length) {
			const next = text.charCodeAt(end);
			if (next === 0x09 || (next === 0x1b && ansiCodeLength(text, end) > 0)) break;
			if (isPrintableAsciiCode(next) && asciiStretch(text, end)) break;
			end++;
		}
		for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
			if (!take(segment, graphemeWidth(segment))) break;
		}
		i = end;
	}
	const exhaustedInput = !overflowed && i >= text.length;

	if (!overflowed && exhaustedInput) {
		return pad ? text + " ".repeat(Math.max(0, maxWidth - visibleSoFar)) : text;
	}

	return finalizeTruncatedResult(result, keptWidth, ellipsis, ellipsisWidth, maxWidth, pad);
}
