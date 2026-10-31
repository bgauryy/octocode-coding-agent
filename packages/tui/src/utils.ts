import { extractAnsiCode, mayHaveStrippableCode, strippableCodeLength } from "./utils/ansi-codes.ts";
import { visibleWidth } from "./utils/width.ts";
import { flattenLines } from "./utils/wrap.ts";

/** Remove ESC and 8-bit C1 control sequences (CSI, OSC, APC, DCS and others) while preserving visible text. */
export function stripTerminalSequences(str: string): string {
	if (!mayHaveStrippableCode(str)) return str;
	let result = "";
	let i = 0;
	while (i < str.length) {
		const length = strippableCodeLength(str, i);
		if (length > 0) {
			i += length;
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
	const fill = (line: string): string => {
		const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		return bgFn ? bgFn(padded) : padded;
	};
	const margin = " ".repeat(paddingX);
	const contentLines = lines.map((line) => (keepRow?.(line) ? line : fill(margin + line + margin)));
	const blankLines: string[] = [];
	for (let i = 0; i < paddingY; i++) blankLines.push(fill(" ".repeat(width)));
	const result = [...blankLines, ...contentLines, ...blankLines];
	flattenLines(result);
	return result;
}
