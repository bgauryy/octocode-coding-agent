import { BEGIN_SYNCHRONIZED_OUTPUT } from "../terminal/sequences.ts";
import { isImageLine } from "../terminal-image.ts";
import { eraseAndWriteRow } from "../tui/row-text.ts";
import { getKittyImageReservedRows } from "./kitty-images.ts";
import type { BoundedTerminalWriter } from "./terminal-writer.ts";

/** tmux ends a synchronized update one second after it begins; renewing this often keeps a long replay inside one. */
export const SYNC_RENEW_INTERVAL_CHARS = 16 * 1024;

/**
 * Append every line of a full render, reserving the rows each Kitty image covers when it fits the screen.
 * With `renewSync`, re-issue `?2026h` between rows once `SYNC_RENEW_INTERVAL_CHARS` have been written since the last
 * one: tmux restarts its one-second expiry on each, so a multi-second history replay stays one atomic update.
 */
export function appendFullRenderLines(
	output: BoundedTerminalWriter,
	newLines: string[],
	height: number,
	renewSync = false,
): void {
	let lastSyncAt = output.length;
	for (let i = 0; i < newLines.length; i++) {
		if (i > 0) output.append("\r\n");
		if (renewSync && output.length - lastSyncAt >= SYNC_RENEW_INTERVAL_CHARS) {
			output.append(BEGIN_SYNCHRONIZED_OUTPUT);
			lastSyncAt = output.length;
		}
		const line = newLines[i];
		const isImage = isImageLine(line);
		const imageReservedRows = isImage ? getKittyImageReservedRows(newLines, i) : 1;
		if (imageReservedRows > 1 && imageReservedRows <= height) {
			for (let row = 1; row < imageReservedRows; row++) {
				output.append("\r\n");
			}
			output.append(`\x1b[${imageReservedRows - 1}A`);
			output.append(line);
			output.append(`\x1b[${imageReservedRows - 1}B`);
			i += imageReservedRows - 1;
			continue;
		}
		output.append(line);
	}
}

/** Clear the rows below the new content without scrolling, then move back to the end of the content. */
export function appendClearedExtraLines(output: BoundedTerminalWriter, extraLines: number, newLineCount: number): void {
	const clearStartOffset = newLineCount === 0 ? 0 : 1;
	if (extraLines > 0 && clearStartOffset > 0) {
		output.append(`\x1b[${clearStartOffset}B`);
	}
	for (let i = 0; i < extraLines; i++) {
		output.append("\r\x1b[2K");
		if (i < extraLines - 1) output.append("\x1b[1B");
	}
	const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
	if (moveBack > 0) {
		output.append(`\x1b[${moveBack}A`);
	}
}

/** Relative row move plus absolute column move for the hardware cursor. */
export function cursorMoveSequence(rowDelta: number, targetCol: number): string {
	let buffer = "";
	if (rowDelta > 0) {
		buffer += `\x1b[${rowDelta}B`; // Move down
	} else if (rowDelta < 0) {
		buffer += `\x1b[${-rowDelta}A`; // Move up
	}
	// Move to absolute column (1-indexed)
	buffer += `\x1b[${targetCol + 1}G`;
	return buffer;
}

/**
 * Write rows `firstChanged` to `renderEnd`, the cursor already on `firstChanged`, skipping unchanged rows between
 * changed ones. Returns why the frame must replay the transcript instead when a Kitty image block cannot be redrawn
 * in place, otherwise undefined.
 */
export function appendChangedRows(
	output: BoundedTerminalWriter,
	frame: {
		newLines: string[];
		previousLines: string[];
		firstChanged: number;
		renderEnd: number;
		viewportTop: number;
		height: number;
	},
): string | undefined {
	const { newLines, previousLines, firstChanged, renderEnd, viewportTop, height } = frame;
	for (let i = firstChanged; i <= renderEnd; i++) {
		if (i > firstChanged) output.append("\r\n");
		const line = newLines[i];
		const isImage = isImageLine(line);
		const imageReservedRows = isImage ? getKittyImageReservedRows(newLines, i, renderEnd) : 1;
		if (imageReservedRows > 1) {
			const imageStartScreenRow = i - viewportTop;
			if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
				return `kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`;
			}

			output.append("\x1b[2K");
			for (let row = 1; row < imageReservedRows; row++) {
				output.append("\r\n\x1b[2K");
			}
			output.append(`\x1b[${imageReservedRows - 1}A`);
			output.append(line);
			output.append(`\x1b[${imageReservedRows - 1}B`);
			i += imageReservedRows - 1;
			continue;
		}

		// An unchanged row between changed ones is already on screen: step over it.
		if (i < previousLines.length && line === previousLines[i] && !isImage) continue;
		output.append(eraseAndWriteRow(line, isImage));
	}

	return undefined;
}
