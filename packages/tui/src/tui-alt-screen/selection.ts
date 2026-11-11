import type { ScrollView } from "../components/scroll-view.ts";
import type { LayoutFrame, ScrollbarGeometry } from "../layout/types.ts";
import { getScrollViewBox } from "../layout.ts";
import { isImageLine } from "../terminal-image.ts";
import { getWordSegmenter, visibleWidth } from "../utils/width.ts";
import { getGraphemeCellRange, sliceByColumn } from "../utils/columns.ts";
import { extractAnsiCode } from "../utils/ansi-codes.ts";
import { stripTerminalSequences } from "../utils.ts";
import type { SelectionPoint, SelectionRange } from "./types.ts";

// Regular mode delegates double-click selection to the terminal emulator. Fullscreen owns mouse selection,
// so mirror common terminal word-selection behavior by keeping paths and kebab-case tokens whole.
const TERMINAL_WORD_SELECTION_JOINERS = new Set(["/", "-"]);
const wordSegmenter = getWordSegmenter();

export function getWordSelection(sourceLine: string, point: SelectionPoint): SelectionRange | undefined {
	const line = stripTerminalSequences(sourceLine);
	const segments: Array<{ start: number; end: number; selectable: boolean; joiner: boolean }> = [];
	let start = 0;
	for (const segment of wordSegmenter.segment(line)) {
		const end = start + visibleWidth(segment.segment);
		const joiner = TERMINAL_WORD_SELECTION_JOINERS.has(segment.segment);
		segments.push({ start, end, selectable: segment.isWordLike === true || joiner, joiner });
		start = end;
	}
	const clickedSegmentIndex = segments.findIndex((segment) => point.col >= segment.start && point.col < segment.end);
	if (clickedSegmentIndex < 0) return undefined;

	const canJoin = (
		left: { selectable: boolean; joiner: boolean },
		right: { selectable: boolean; joiner: boolean },
	): boolean => left.selectable && right.selectable && (left.joiner || right.joiner);
	let selectionStart = segments[clickedSegmentIndex].start;
	let selectionEnd = segments[clickedSegmentIndex].end;
	for (let index = clickedSegmentIndex; index > 0 && canJoin(segments[index - 1], segments[index]); index--) {
		selectionStart = segments[index - 1].start;
	}
	for (
		let index = clickedSegmentIndex;
		index < segments.length - 1 && canJoin(segments[index], segments[index + 1]);
		index++
	) {
		selectionEnd = segments[index + 1].end;
	}
	return {
		start: { ...point, col: selectionStart },
		end: { ...point, col: selectionEnd, boundary: true },
	};
}

/** Order the anchor and focus of a selection; undefined when they differ in scroll view or coincide. */
export function getSelectionBounds(
	selectionAnchor: SelectionPoint | undefined,
	selectionFocus: SelectionPoint | undefined,
): { start: SelectionPoint; end: SelectionPoint } | undefined {
	if (!selectionAnchor || !selectionFocus) return undefined;
	if (selectionAnchor.scrollView !== selectionFocus.scrollView) return undefined;
	const anchorBeforeFocus =
		selectionAnchor.row < selectionFocus.row ||
		(selectionAnchor.row === selectionFocus.row && selectionAnchor.col < selectionFocus.col);
	if (selectionAnchor.row === selectionFocus.row && selectionAnchor.col === selectionFocus.col) {
		return undefined;
	}
	return anchorBeforeFocus
		? { start: selectionAnchor, end: selectionFocus }
		: { start: selectionFocus, end: selectionAnchor };
}

function getSelectionColumns(
	line: string,
	row: number,
	selection: { start: SelectionPoint; end: SelectionPoint },
	minColumn = 0,
	maxColumn = visibleWidth(line),
): { start: number; end: number } {
	const lineWidth = visibleWidth(line);
	let start = Math.max(0, minColumn);
	let end = Math.min(lineWidth, maxColumn);
	if (row === selection.start.row) {
		start = getGraphemeCellRange(line, selection.start.col)?.start ?? Math.min(selection.start.col, lineWidth);
	}
	if (row === selection.end.row) {
		end = selection.end.boundary
			? Math.min(selection.end.col, lineWidth)
			: (getGraphemeCellRange(line, selection.end.col)?.end ?? Math.min(selection.end.col + 1, lineWidth));
	}
	return { start: Math.max(minColumn, start), end: Math.min(maxColumn, end) };
}

function applySelectionHighlight(text: string): string {
	let result = "\x1b[7m";
	let index = 0;
	while (index < text.length) {
		const ansi = extractAnsiCode(text, index);
		if (!ansi) {
			result += text[index];
			index += 1;
			continue;
		}
		result += ansi.code;
		if (ansi.code.endsWith("m")) result += "\x1b[7m";
		index += ansi.length;
	}
	return `${result}\x1b[27m`;
}

export function scrollScrollbarToPointer(
	scrollView: ScrollView,
	geometry: ScrollbarGeometry,
	pointerY: number,
	grabOffset: number,
): void {
	const maxThumbOffset = geometry.trackHeight - geometry.thumbHeight;
	const thumbOffset = Math.max(0, Math.min(maxThumbOffset, pointerY - geometry.trackTop - grabOffset));
	const scrollTop = maxThumbOffset === 0 ? 0 : Math.round((thumbOffset / maxThumbOffset) * geometry.maxScrollTop);
	scrollView.scrollTo(scrollTop);
}

/** The plain text of a selection, read from scroll content or from the last rendered frame. */
export function getSelectionText(
	selection: { start: SelectionPoint; end: SelectionPoint } | undefined,
	previousScreen: readonly string[],
	currentLayout: LayoutFrame | undefined,
): string | undefined {
	if (!selection) return undefined;
	let sourceLines: readonly string[] = previousScreen;
	if (selection.start.scrollView) {
		if (!currentLayout) return undefined;
		const box = getScrollViewBox(currentLayout, selection.start.scrollView);
		if (!box?.scrollContentLines) return undefined;
		sourceLines = box.scrollContentLines;
	}
	const lines: string[] = [];
	for (let row = selection.start.row; row <= selection.end.row; row++) {
		const line = sourceLines[row] ?? "";
		const columns = getSelectionColumns(line, row, selection);
		lines.push(
			stripTerminalSequences(
				sliceByColumn(line, columns.start, Math.max(0, columns.end - columns.start), true),
			).trimEnd(),
		);
	}
	const text = lines.join("\n");
	return text.length === 0 ? undefined : text;
}

/** Highlight a selection on screen, mapping scroll-content rows and clipping to the scroll view. */
export function applySelectionToScreen(
	screen: string[],
	selection: { start: SelectionPoint; end: SelectionPoint } | undefined,
	layout: LayoutFrame | undefined,
	terminalColumns: number,
): string[] {
	if (!selection) return screen;
	let screenSelection = selection;
	let minRow = 0;
	let maxRow = screen.length - 1;
	let minColumn = 0;
	let maxColumn = terminalColumns;
	if (selection.start.scrollView) {
		if (!layout) return screen;
		const box = getScrollViewBox(layout, selection.start.scrollView);
		if (!box) return screen;
		// Selection rows count the whole content: a virtualized frame measures it first, settling the scroll position.
		box.materialize?.();
		minRow = Math.max(0, box.rect.y, box.clip.y);
		maxRow = Math.min(screen.length - 1, box.rect.y + box.rect.height - 1, box.clip.y + box.clip.height - 1);
		minColumn = Math.max(0, box.rect.x, box.clip.x);
		maxColumn = Math.min(terminalColumns, box.rect.x + box.rect.width, box.clip.x + box.clip.width);
		screenSelection = {
			start: {
				...selection.start,
				row: box.rect.y + selection.start.row - selection.start.scrollView.scrollTop,
				col: box.rect.x + selection.start.col,
			},
			end: {
				...selection.end,
				row: box.rect.y + selection.end.row - selection.start.scrollView.scrollTop,
				col: box.rect.x + selection.end.col,
			},
		};
	}
	return screen.map((line, row) => {
		if (
			row < minRow ||
			row > maxRow ||
			row < screenSelection.start.row ||
			row > screenSelection.end.row ||
			isImageLine(line)
		) {
			return line;
		}
		const lineWidth = visibleWidth(line);
		const columns = getSelectionColumns(line, row, screenSelection, minColumn, maxColumn);
		if (columns.end <= columns.start) return line;
		const before = sliceByColumn(line, 0, columns.start, true);
		const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
		const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
		return `${before}${applySelectionHighlight(selected)}${after}`;
	});
}
