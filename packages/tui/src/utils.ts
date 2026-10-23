import { extractAnsiCode } from "./utils/ansi-codes.ts";
import { visibleWidth } from "./utils/width.ts";

export { extractAnsiCode } from "./utils/ansi-codes.ts";
export { getActiveBackgroundAnsi } from "./utils/ansi-tracker.ts";
export {
	autocompleteBoundaryRegex,
	autocompleteSeparatorRegex,
	cjkBreakRegex,
	cjkPunctuationRegex,
	isPunctuationChar,
	isWhitespaceChar,
	PUNCTUATION_REGEX,
} from "./utils/chars.ts";
export {
	extractSegments,
	getGraphemeCellRange,
	getOsc8LinkAtColumn,
	sliceByColumn,
	sliceWithWidth,
} from "./utils/columns.ts";
export { truncateToWidth } from "./utils/truncate.ts";
export { getGraphemeSegmenter, getWordSegmenter, visibleWidth } from "./utils/width.ts";
export { flattenLines, splitWideGrapheme, wrapTextWithAnsi } from "./utils/wrap.ts";

/** Remove ANSI, OSC, and APC control sequences while preserving visible text. */
export function stripTerminalSequences(str: string): string {
	if (!str.includes("\x1b")) return str;
	let result = "";
	let i = 0;
	while (i < str.length) {
		const ansi = extractAnsiCode(str, i);
		if (ansi) {
			i += ansi.length;
			continue;
		}
		result += str[i];
		i++;
	}
	return result;
}

/**
 * Normalize text for terminal output without changing logical editor content.
 * Some terminals render precomposed Thai/Lao AM vowels inconsistently during
 * differential repaint. Their compatibility decompositions have the same cell
 * width but avoid stale-cell artifacts in terminal renderers. Visible tabs are
 * expanded to the fixed width used by layout so terminal tab stops cannot wrap
 * a logical line, while tabs inside terminal string sequences stay untouched.
 */
const THAI_LAO_AM_REGEX = /[\u0e33\u0eb3]/;
const THAI_LAO_AM_GLOBAL_REGEX = /[\u0e33\u0eb3]/g;

export function normalizeTerminalOutput(str: string): string {
	let normalized = str;
	if (THAI_LAO_AM_REGEX.test(normalized)) {
		normalized = normalized.replace(THAI_LAO_AM_GLOBAL_REGEX, (char) =>
			char === "\u0e33" ? "\u0e4d\u0e32" : "\u0ecd\u0eb2",
		);
	}
	if (!normalized.includes("\t")) return normalized;

	let result = "";
	let i = 0;
	while (i < normalized.length) {
		const ansi = extractAnsiCode(normalized, i);
		if (ansi) {
			result += ansi.code;
			i += ansi.length;
			continue;
		}
		result += normalized[i] === "\t" ? "   " : normalized[i];
		i++;
	}
	return result;
}

/**
 * Apply background color to a line, padding to full width.
 *
 * @param line - Line of text (may contain ANSI codes)
 * @param width - Total width to pad to
 * @param bgFn - Background color function
 * @returns Line with background applied and padded to width
 */
export function applyBackgroundToLine(line: string, width: number, bgFn: (text: string) => string): string {
	// Calculate padding needed
	const visibleLen = visibleWidth(line);
	const paddingNeeded = Math.max(0, width - visibleLen);
	const padding = " ".repeat(paddingNeeded);

	// Apply background to content + padding
	const withPadding = line + padding;
	return bgFn(withPadding);
}
