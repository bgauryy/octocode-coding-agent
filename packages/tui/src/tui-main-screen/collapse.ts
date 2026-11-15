import { findKittyImageRows } from "./kitty-images.ts";

/** The renderer's idea of where the terminal is, in transcript rows. */
export interface RowAnchor {
	previousLines: string[];
	/** The transcript row at the top of the terminal screen. */
	viewportTop: number;
	/** The transcript row the terminal cursor stands on. */
	hardwareCursorRow: number;
	maxLinesRendered: number;
}

/**
 * Rows that left the transcript above the screen (a tool result collapsed after it scrolled away) cannot be taken out
 * of the terminal's scrollback. Instead of clearing everything and writing the transcript again, the screen keeps its
 * bottom row: the rows on it stay where they are and the transcript's row numbers move up by the rows that left, so
 * that its last row is still the screen's last row. Scrollback keeps the rows that left; the next frame writes only
 * what differs on screen. Returns the moved anchor, or undefined when the rows cannot move: the transcript did not
 * shrink, it shrank by more than the rows above the screen, or an image (uploaded once, tracked by id) is on either side.
 */
export function anchorShrunkTranscript(anchor: RowAnchor, newLines: readonly string[]): RowAnchor | undefined {
	const shrink = anchor.previousLines.length - newLines.length;
	if (shrink <= 0 || shrink > anchor.viewportTop) return undefined;
	if (findKittyImageRows(anchor.previousLines).size > 0 || findKittyImageRows(newLines).size > 0) {
		return undefined;
	}
	const viewportTop = anchor.viewportTop - shrink;
	return {
		// Row i of the result is the row the terminal shows at transcript row i of the new frame; rows above the screen
		// are never compared.
		previousLines: anchor.previousLines.slice(shrink),
		viewportTop,
		hardwareCursorRow: Math.max(viewportTop, anchor.hardwareCursorRow - shrink),
		maxLinesRendered: Math.max(newLines.length, anchor.maxLinesRendered - shrink),
	};
}
