import { extractAnsiCode } from "./ansi-codes.ts";
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

	if (isPrintableAscii(text)) {
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
	let exhaustedInput = false;
	const hasAnsi = text.includes("\x1b");
	const hasTabs = text.includes("\t");

	if (!hasAnsi && !hasTabs) {
		for (const { segment } of graphemeSegmenter.segment(text)) {
			const width = graphemeWidth(segment);
			if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
				result += segment;
				keptWidth += width;
			} else {
				keepContiguousPrefix = false;
			}
			visibleSoFar += width;
			if (visibleSoFar > maxWidth) {
				overflowed = true;
				break;
			}
		}
		exhaustedInput = !overflowed;
	} else {
		let i = 0;
		while (i < text.length) {
			const ansi = extractAnsiCode(text, i);
			if (ansi) {
				pendingAnsi += ansi.code;
				i += ansi.length;
				continue;
			}

			if (text[i] === "\t") {
				if (keepContiguousPrefix && keptWidth + 3 <= targetWidth) {
					if (pendingAnsi) {
						result += pendingAnsi;
						pendingAnsi = "";
					}
					result += "\t";
					keptWidth += 3;
				} else {
					keepContiguousPrefix = false;
					pendingAnsi = "";
				}
				visibleSoFar += 3;
				if (visibleSoFar > maxWidth) {
					overflowed = true;
					break;
				}
				i++;
				continue;
			}

			const end = plainRunEnd(text, i);
			for (const { segment } of graphemeSegmenter.segment(text.slice(i, end))) {
				const width = graphemeWidth(segment);
				if (keepContiguousPrefix && keptWidth + width <= targetWidth) {
					if (pendingAnsi) {
						result += pendingAnsi;
						pendingAnsi = "";
					}
					result += segment;
					keptWidth += width;
				} else {
					keepContiguousPrefix = false;
					pendingAnsi = "";
				}

				visibleSoFar += width;
				if (visibleSoFar > maxWidth) {
					overflowed = true;
					break;
				}
			}
			if (overflowed) {
				break;
			}
			i = end;
		}
		exhaustedInput = i >= text.length;
	}

	if (!overflowed && exhaustedInput) {
		return pad ? text + " ".repeat(Math.max(0, maxWidth - visibleSoFar)) : text;
	}

	return finalizeTruncatedResult(result, keptWidth, ellipsis, ellipsisWidth, maxWidth, pad);
}
