/**
 * Row marks: zero-width APC sequences a producer puts in a rendered row to tell transcript search and selection copy
 * what the row is. Terminals ignore APC; the renderer strips every mark before output (`resolveFakeCursors`), as it
 * does cursor markers.
 */

import { stripTerminalSequences } from "./ansi-codes.ts";
import { LEADING_FRAME } from "./row-frame.ts";

/** APC string terminator (ST, ESC \). */
const ST = "\x1b\\";

/** Starts a row that continues the previous row's last word: the width cut the word between two characters. */
export const WRAP_JOIN_MARK = `\x1b_octo:wj${ST}`;

/**
 * Starts a row the width broke off the previous row at a space: copy joins the two rows with one space. Only content
 * a scroll view renders carries it (`withSoftWrapMarks`): that is the content fullscreen selection copies from, and
 * every other output (the footer, an export, a component's own render) stays free of it.
 */
export const WRAP_SPACE_MARK = `\x1b_octo:ws${ST}`;

let softWrapMarking = 0;

/** Render with rows broken at a space marked (`WRAP_SPACE_MARK`), as scroll-view content renders. */
export function withSoftWrapMarks<T>(render: () => T): T {
	softWrapMarking++;
	try {
		return render();
	} finally {
		softWrapMarking--;
	}
}

/** The space mark while scroll-view content renders, else nothing. */
export function softWrapSpaceMark(): string {
	return softWrapMarking > 0 ? WRAP_SPACE_MARK : "";
}

/** Marks a row that stands for hidden content (a collapsed block's "… N lines hidden" line). */
const FOLD_MARK = `\x1b_octo:fold${ST}`;

const ROW_MARK = /\x1b_octo:(?:wj|ws|fold)\x1b\\/g;

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

/** How a soft-wrapped row continues the previous row, and where its mark sits (the frame before it is not text). */
export interface RowContinuation {
	/** `join`: the width cut a word, so the rows join without a space; `space`: the rows join with one space. */
	readonly kind: "join" | "space";
	/** The code-unit index of the mark in the row. */
	readonly at: number;
	/** The code-unit length of the mark. */
	readonly length: number;
}

/** The soft wrap `line` continues, when a wrap mark comes before the row's text; undefined for a row of its own. */
export function rowContinuation(line: string): RowContinuation | undefined {
	for (const [kind, mark] of [
		["join", WRAP_JOIN_MARK],
		["space", WRAP_SPACE_MARK],
	] as const) {
		const at = line.indexOf(mark);
		if (at >= 0 && LEADING_FRAME.test(stripTerminalSequences(line.slice(0, at)))) {
			return { kind, at, length: mark.length };
		}
	}
	return undefined;
}

export function isFoldRow(line: string): boolean {
	return line.includes(FOLD_MARK);
}
