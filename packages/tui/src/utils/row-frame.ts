/**
 * The box border a row may carry. Borders are drawn frame, not text: a copy leaves them out, and a soft-wrapped line
 * joins across them. This is the one place that says which glyphs and how much padding make a border.
 */

const FRAME_GLYPHS = "│┃";

/** What may precede a wrap mark on its row: indent and a box gutter, no text. */
export const LEADING_FRAME = new RegExp(`^[\\s${FRAME_GLYPHS}]*$`, "u");
/** The end of a row: blanks, then an optional border, then blanks. */
export const TRAILING_FRAME = new RegExp(`\\s*[${FRAME_GLYPHS}]?\\s*$`, "u");
/** A border at the end of a row, with the padding before it. */
export const TRAILING_GUTTER = new RegExp(`\\s*[${FRAME_GLYPHS}]$`, "u");
const LEADING_GUTTER = new RegExp(`^[${FRAME_GLYPHS}] ?`, "u");

/** A plain row without its left border and padding and/or its right padding and border, as the edges say. */
export function stripRowFrame(row: string, edges: { start: boolean; end: boolean }): string {
	const head = edges.start ? row.replace(LEADING_GUTTER, "") : row;
	return edges.end ? head.replace(TRAILING_GUTTER, "") : head;
}
