import { isImageLine } from "../terminal-image.ts";
import { getKittyImageReservedRows } from "./kitty-images.ts";
import type { BoundedTerminalWriter } from "./terminal-writer.ts";

/** Append every line of a full render, reserving the rows each Kitty image covers when it fits the screen. */
export function appendFullRenderLines(output: BoundedTerminalWriter, newLines: string[], height: number): void {
	for (let i = 0; i < newLines.length; i++) {
		if (i > 0) output.append("\r\n");
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
