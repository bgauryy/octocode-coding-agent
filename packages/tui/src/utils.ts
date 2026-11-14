import { extractAnsiCode } from "./utils/ansi-codes.ts";
import { visibleWidth } from "./utils/width.ts";
import { flattenLines } from "./utils/wrap.ts";

export { stripTerminalSequences } from "./utils/ansi-codes.ts";

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

/** Shrink horizontal margins when needed to leave at least one column for content. */
export function fitHorizontalPadding(width: number, padding: number): number {
	return Math.min(padding, Math.max(0, Math.floor((width - 1) / 2)));
}

/**
 * Frame wrapped rows for a text component: add `paddingX` spaces on each side and `paddingY` blank rows above and
 * below, pad every row to `width`, and apply `bgFn` across the padded row when given. Rows for which `keepRow`
 * returns true, such as terminal image rows, pass through unchanged.
 */
export function frameContentLines(
	lines: readonly string[],
	width: number,
	paddingX: number,
	paddingY: number,
	bgFn?: (text: string) => string,
	keepRow?: (line: string) => boolean,
): string[] {
	const contentLines = frameContentRows(lines, width, paddingX, bgFn, keepRow);
	const blankLines: string[] = [];
	for (let i = 0; i < paddingY; i++) blankLines.push(frameBlankRow(width, bgFn));
	if (blankLines.length === 0) return contentLines;
	const result = [...blankLines, ...contentLines, ...blankLines];
	flattenLines(blankLines);
	return result;
}

/** One padded blank row of `width`, with `bgFn` applied: the rows `frameContentLines` adds above and below. */
export function frameBlankRow(width: number, bgFn?: (text: string) => string): string {
	const blank = " ".repeat(Math.max(0, width));
	return bgFn ? bgFn(blank) : blank;
}

/**
 * The content rows of `frameContentLines` without the blank rows above and below: each row gets `paddingX` spaces on
 * both sides, is padded to `width` and has `bgFn` applied; rows for which `keepRow` returns true pass through. A caller
 * that keeps the rows of unchanged blocks frames only the rows it adds.
 */
export function frameContentRows(
	lines: readonly string[],
	width: number,
	paddingX: number,
	bgFn?: (text: string) => string,
	keepRow?: (line: string) => boolean,
): string[] {
	const margin = " ".repeat(paddingX);
	const rows = lines.map((line) => {
		if (keepRow?.(line)) return line;
		const framed = margin + line + margin;
		const padded = framed + " ".repeat(Math.max(0, width - visibleWidth(framed)));
		return bgFn ? bgFn(padded) : padded;
	});
	flattenLines(rows);
	return rows;
}
