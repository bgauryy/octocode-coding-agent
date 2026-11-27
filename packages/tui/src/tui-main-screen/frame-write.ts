import { BEGIN_SYNCHRONIZED_OUTPUT } from "../terminal/sequences.ts";
import { deleteChangedKittyImages, type KittyImageRows } from "./kitty-images.ts";
import { appendChangedRows, appendClearedExtraLines } from "./render-output.ts";
import type { BoundedTerminalWriter } from "./terminal-writer.ts";

/** One differential main-screen frame: rows count from the top of the transcript. */
export interface MainScreenFrameChange {
	previousLines: string[];
	newLines: string[];
	/** The first and last row that differ between the two frames. */
	firstChanged: number;
	lastChanged: number;
	previousImageRows: KittyImageRows;
	/** Where the terminal cursor stands before the frame writes. */
	hardwareCursorRow: number;
	/** The transcript row at the top of the terminal before the frame writes. */
	viewportTop: number;
	height: number;
}

/** Append a relative row move: down for a positive delta, up for a negative one. */
function appendRowMove(output: BoundedTerminalWriter, delta: number): void {
	if (delta > 0) output.append(`\x1b[${delta}B`);
	else if (delta < 0) output.append(`\x1b[${-delta}A`);
}

/**
 * Every changed row was deleted: move to the new last row and clear the rows below it. Returns the row the cursor
 * ends on, or why the transcript must replay instead (the end moved above the viewport, or more rows than the screen
 * holds were deleted). The frame stays open: the caller appends the cursor and ends synchronized output.
 */
export function writeDeletedRows(
	output: BoundedTerminalWriter,
	frame: MainScreenFrameChange,
): { cursorRow: number } | { replay: string } {
	const { previousLines, newLines, viewportTop, height } = frame;
	output.append(BEGIN_SYNCHRONIZED_OUTPUT);
	output.append(
		deleteChangedKittyImages(previousLines, frame.firstChanged, frame.lastChanged, frame.previousImageRows),
	);
	// Move to end of new content (clamp to 0 for empty content)
	const targetRow = Math.max(0, newLines.length - 1);
	if (targetRow < viewportTop) return { replay: `deleted lines moved viewport up (${targetRow} < ${viewportTop})` };
	appendRowMove(output, targetRow - frame.hardwareCursorRow);
	output.append("\r");
	const extraLines = previousLines.length - newLines.length;
	if (extraLines > height) return { replay: `extraLines > height (${extraLines} > ${height})` };
	appendClearedExtraLines(output, extraLines, newLines.length);
	return { cursorRow: targetRow };
}

/** Where a differential write left the cursor and the viewport. */
export interface ChangedRowsWrite {
	/** The row the cursor ends on. */
	cursorRow: number;
	/** The viewport top after any scroll that brought the first changed row on screen. */
	viewportTop: number;
	/** The cursor row after that scroll, before the move to the first changed row. */
	hardwareCursorRow: number;
	/** The move to the first changed row. */
	lineDiff: number;
	/** The last row written. */
	renderEnd: number;
}

/**
 * Write the rows from the first changed one to the last, scrolling first when the first one is below the viewport,
 * then clear rows the frame deleted. Returns where the cursor ended, or why the transcript must replay instead. The
 * frame stays open: the caller appends the cursor and ends synchronized output.
 */
export function writeChangedRows(
	output: BoundedTerminalWriter,
	frame: MainScreenFrameChange & { appendStart: boolean },
): ChangedRowsWrite | { replay: string } {
	const { previousLines, newLines, firstChanged, height, appendStart } = frame;
	let { viewportTop, hardwareCursorRow } = frame;
	output.append(BEGIN_SYNCHRONIZED_OUTPUT);
	output.append(deleteChangedKittyImages(previousLines, firstChanged, frame.lastChanged, frame.previousImageRows));
	const viewportBottom = viewportTop + height - 1;
	const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
	if (moveTargetRow > viewportBottom) {
		const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - viewportTop));
		const moveToBottom = height - 1 - currentScreenRow;
		if (moveToBottom > 0) output.append(`\x1b[${moveToBottom}B`);
		const scroll = moveTargetRow - viewportBottom;
		output.append("\r\n".repeat(scroll));
		viewportTop += scroll;
		hardwareCursorRow = moveTargetRow;
	}

	// Move cursor to first changed line (use hardwareCursorRow for actual position)
	const lineDiff = moveTargetRow - hardwareCursorRow;
	appendRowMove(output, lineDiff);
	output.append(appendStart ? "\r\n" : "\r"); // Move to column 0

	// Only render changed lines (firstChanged to lastChanged), not all lines to end
	// This reduces flicker when only a single line changes (e.g., spinner animation)
	const renderEnd = Math.min(frame.lastChanged, newLines.length - 1);
	const replay = appendChangedRows(output, { newLines, previousLines, firstChanged, renderEnd, viewportTop, height });
	if (replay) return { replay };

	// Track where cursor ended up after rendering
	let cursorRow = renderEnd;
	// If we had more lines before, clear them and move cursor back
	if (previousLines.length > newLines.length) {
		// Move to end of new content first if we stopped before it
		if (renderEnd < newLines.length - 1) {
			output.append(`\x1b[${newLines.length - 1 - renderEnd}B`);
			cursorRow = newLines.length - 1;
		}
		const extraLines = previousLines.length - newLines.length;
		for (let i = newLines.length; i < previousLines.length; i++) {
			output.append("\r\n\x1b[2K");
		}
		// Move cursor back to end of new content
		output.append(`\x1b[${extraLines}A`);
	}
	return { cursorRow, viewportTop, hardwareCursorRow, lineDiff, renderEnd };
}
