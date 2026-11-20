/**
 * Row marks: zero-width APC sequences a producer puts in a rendered row to tell transcript search what the row is.
 * Terminals ignore APC; the renderer strips every mark before output (`resolveFakeCursors`), as it does cursor markers.
 */

import { stripTerminalSequences } from "./ansi-codes.ts";

/** APC string terminator (ST, ESC \). */
const ST = "\x1b\\";

/** Starts a row that continues the previous row's last word: the width cut the word between two characters. */
export const WRAP_JOIN_MARK = `\x1b_octo:wj${ST}`;

/** Marks a row that stands for hidden content (a collapsed block's "… N lines hidden" line). */
const FOLD_MARK = `\x1b_octo:fold${ST}`;

const ROW_MARK = /\x1b_octo:(?:wj|fold)\x1b\\/g;
/** What may precede a join mark on its row: indent and a box gutter, no text. */
const LEADING_FRAME = /^[\s│┃]*$/u;

/** `text` marked as standing for hidden content, so search can say that the hidden text was not searched. */
export function markFolded(text: string): string {
	return `${FOLD_MARK}${text}`;
}

export function stripRowMarks(line: string): string {
	return line.replace(ROW_MARK, "");
}

/**
 * Whether `line`'s first word continues the previous row's last word. Only a join mark before the row's text counts:
 * a later one was carried into the middle of a row by a caller that re-wrapped joined rows.
 */
export function continuesPreviousRow(line: string): boolean {
	const at = line.indexOf(WRAP_JOIN_MARK);
	return at >= 0 && LEADING_FRAME.test(stripTerminalSequences(line.slice(0, at)));
}

export function isFoldRow(line: string): boolean {
	return line.includes(FOLD_MARK);
}
