import { expandChangedRangeForKittyImages } from "./kitty-images.ts";

export interface TuiMainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
}

/**
 * Find the first and last changed lines, widened to whole Kitty image blocks; both are -1 when nothing changed.
 * Rows before `fromRow` are not compared: the caller has decided they cannot be redrawn.
 */
export function findChangedLineRange(
	previousLines: string[],
	newLines: string[],
	fromRow = 0,
): { firstChanged: number; lastChanged: number; appendedLines: boolean } {
	let firstChanged = -1;
	let lastChanged = -1;
	const maxLines = Math.max(newLines.length, previousLines.length);
	for (let i = fromRow; i < maxLines; i++) {
		const oldLine = i < previousLines.length ? previousLines[i] : "";
		const newLine = i < newLines.length ? newLines[i] : "";

		if (oldLine !== newLine) {
			if (firstChanged === -1) {
				firstChanged = i;
			}
			lastChanged = i;
		}
	}
	const appendedLines = newLines.length > previousLines.length;
	if (appendedLines) {
		if (firstChanged === -1) {
			firstChanged = Math.max(previousLines.length, fromRow);
		}
		lastChanged = newLines.length - 1;
	}
	if (firstChanged !== -1) {
		const expandedRange = expandChangedRangeForKittyImages(previousLines, firstChanged, lastChanged, newLines);
		firstChanged = expandedRange.firstChanged;
		lastChanged = expandedRange.lastChanged;
	}
	return { firstChanged, lastChanged, appendedLines };
}
