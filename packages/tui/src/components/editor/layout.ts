import { visibleWidth } from "../../utils/width.ts";
import { sliceByColumn } from "../../utils/columns.ts";
import type { EditorState, LayoutLine } from "./types.ts";
import { wordWrapLine } from "./word-wrap.ts";

export function createScrollBorder(direction: "↑" | "↓", hiddenLineCount: number, width: number): string {
	const availableWidth = Math.max(0, width);
	const label = ` ${direction} ${hiddenLineCount} more `;
	const labelWidth = visibleWidth(label);
	if (labelWidth + 2 <= availableWidth) {
		const leftWidth = Math.floor((availableWidth - labelWidth) / 2);
		return "─".repeat(leftWidth) + label + "─".repeat(availableWidth - leftWidth - labelWidth);
	}

	const indicator = `─── ${direction} ${hiddenLineCount} more `;
	const remaining = availableWidth - visibleWidth(indicator);
	if (remaining >= 0) return indicator + "─".repeat(remaining);

	const ellipsis = "...".slice(0, availableWidth);
	const indicatorWidth = availableWidth - visibleWidth(ellipsis);
	return sliceByColumn(indicator, 0, indicatorWidth, true) + ellipsis;
}

/** Lay out the editor lines for `contentWidth`, marking the layout line that holds the cursor. */
export function layoutText(
	state: EditorState,
	contentWidth: number,
	segmentGraphemes: (line: string) => Intl.SegmentData[],
): LayoutLine[] {
	const layoutLines: LayoutLine[] = [];

	if (state.lines.length === 0 || (state.lines.length === 1 && state.lines[0] === "")) {
		layoutLines.push({
			text: "",
			hasCursor: true,
			cursorPos: 0,
		});
		return layoutLines;
	}

	for (let i = 0; i < state.lines.length; i++) {
		const line = state.lines[i] || "";
		const isCurrentLine = i === state.cursorLine;
		const lineVisibleWidth = visibleWidth(line);

		if (lineVisibleWidth <= contentWidth) {
			if (isCurrentLine) {
				layoutLines.push({
					text: line,
					hasCursor: true,
					cursorPos: state.cursorCol,
				});
			} else {
				layoutLines.push({
					text: line,
					hasCursor: false,
				});
			}
		} else {
			const chunks = wordWrapLine(line, contentWidth, segmentGraphemes(line));

			for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
				const chunk = chunks[chunkIndex];
				if (!chunk) continue;

				const cursorPos = state.cursorCol;
				const isLastChunk = chunkIndex === chunks.length - 1;

				// Determine if cursor is in this chunk
				// For word-wrapped chunks, we need to handle the case where
				// cursor might be in trimmed whitespace at end of chunk
				let hasCursorInChunk = false;
				let adjustedCursorPos = 0;

				if (isCurrentLine) {
					if (isLastChunk) {
						hasCursorInChunk = cursorPos >= chunk.startIndex;
						adjustedCursorPos = cursorPos - chunk.startIndex;
					} else {
						// Non-last chunk: cursor belongs here if in range [startIndex, endIndex)
						// But we need to handle the visual position in the trimmed text
						hasCursorInChunk = cursorPos >= chunk.startIndex && cursorPos < chunk.endIndex;
						if (hasCursorInChunk) {
							adjustedCursorPos = cursorPos - chunk.startIndex;
							// Clamp to text length (in case cursor was in trimmed whitespace)
							if (adjustedCursorPos > chunk.text.length) {
								adjustedCursorPos = chunk.text.length;
							}
						}
					}
				}

				if (hasCursorInChunk) {
					layoutLines.push({
						text: chunk.text,
						hasCursor: true,
						cursorPos: adjustedCursorPos,
					});
				} else {
					layoutLines.push({
						text: chunk.text,
						hasCursor: false,
					});
				}
			}
		}
	}

	return layoutLines;
}

/**
 * Build a mapping from visual lines to logical positions.
 * Returns an array where each element represents a visual line with:
 * - logicalLine: index into `lines`
 * - startCol: starting column in the logical line
 * - length: length of this visual line segment
 */
export function buildVisualLineMap(
	lines: string[],
	width: number,
	segmentGraphemes: (line: string) => Intl.SegmentData[],
): Array<{ logicalLine: number; startCol: number; length: number }> {
	const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] || "";
		const lineVisWidth = visibleWidth(line);
		if (line.length === 0) {
			visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
		} else if (lineVisWidth <= width) {
			visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
		} else {
			const chunks = wordWrapLine(line, width, segmentGraphemes(line));
			for (const chunk of chunks) {
				visualLines.push({
					logicalLine: i,
					startCol: chunk.startIndex,
					length: chunk.endIndex - chunk.startIndex,
				});
			}
		}
	}

	return visualLines;
}

/**
 * Find the visual line index that contains the given logical position.
 */
export function findVisualLineAt(
	visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
	line: number,
	col: number,
): number {
	for (let i = 0; i < visualLines.length; i++) {
		const vl = visualLines[i];
		if (!vl || vl.logicalLine !== line) continue;
		const offset = col - vl.startCol;
		// Cursor is in this segment if it's within range. For the last
		// segment of a logical line, cursor can be at length (end position)
		const isLastSegmentOfLine = i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
		if (offset >= 0 && (offset < vl.length || (isLastSegmentOfLine && offset === vl.length))) {
			return i;
		}
	}
	return visualLines.length - 1;
}
