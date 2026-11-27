/** Cursor visibility, relative moves and clears: the sequences the terminal and the frame writers share. */

export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";
/** Erase from the cursor to the end of the line. */
export const CLEAR_LINE = "\x1b[K";
/** Erase from the cursor to the end of the screen. */
export const CLEAR_FROM_CURSOR = "\x1b[J";
/** Clear the screen and move to home (1,1). */
export const CLEAR_SCREEN = "\x1b[2J\x1b[H";

/** A relative row move: down for a positive count, up for a negative one, nothing for zero. */
export function moveRowsSequence(lines: number): string {
	if (lines > 0) return `\x1b[${lines}B`;
	if (lines < 0) return `\x1b[${-lines}A`;
	return "";
}
