import type { LayoutFrame } from "../layout/types.ts";
import { getScrollViewBox } from "../layout.ts";
import { visibleWidth } from "../utils/width.ts";
import { stripTerminalSequences } from "../utils.ts";
import { TRAILING_FRAME } from "../utils/row-frame.ts";
import { rowContinuation } from "../utils/row-marks.ts";
import { DOUBLE_CLICK_INTERVAL_MS } from "./constants.ts";
import { getWordSelection, selectionSourceLine } from "./selection.ts";
import type { ClickTarget, SelectionPoint, SelectionRange } from "./types.ts";

/**
 * The units a multi-click selects, across the rows the width wrapped: a word the width cut and a paragraph broken over
 * rows are one word and one line, as a terminal selects a soft-wrapped line.
 */

/** The drawn row at an index, or undefined past the content. */
type RowReader = (row: number) => string | undefined;

/** A row and column of a selection unit; the end column is exclusive. */
interface UnitBounds {
	start: { row: number; col: number };
	end: { row: number; col: number };
}

/** How far a unit may reach over wrapped rows: bounds the walk on a pathological row run. */
const MAX_WRAPPED_ROWS = 1000;

/** The column a continued row's text starts at (after its indent and gutter); undefined for a row of its own. */
function continuedTextStart(line: string, kind?: "join"): number | undefined {
	const continuation = rowContinuation(line);
	if (!continuation || (kind && continuation.kind !== kind)) return undefined;
	return visibleWidth(stripTerminalSequences(line.slice(0, continuation.at)));
}

/** The column just past a row's last text cell, without a trailing border or blanks. */
function textEnd(line: string): number {
	return visibleWidth(stripTerminalSequences(line).replace(TRAILING_FRAME, ""));
}

/** The first and last row of the soft-wrapped line `row` belongs to. */
function logicalLineRows(rowAt: RowReader, row: number): { first: number; last: number } {
	let first = row;
	while (first > 0 && row - first < MAX_WRAPPED_ROWS && rowContinuation(rowAt(first) ?? "")) first--;
	let last = row;
	while (last - row < MAX_WRAPPED_ROWS) {
		const next = rowAt(last + 1);
		if (next === undefined || !rowContinuation(next)) break;
		last++;
	}
	return { first, last };
}

/**
 * The line a triple-click selects: from the first column of its first row to the end of its last. A blank line has
 * no text to span (its row is only padding), so it ends where the next line begins: the selection holds the line
 * and its break.
 */
function logicalLineBounds(rowAt: RowReader, row: number): UnitBounds {
	const { first, last } = logicalLineRows(rowAt, row);
	const lastWidth = visibleWidth(rowAt(last) ?? "");
	if (first === last && textEnd(rowAt(last) ?? "") === 0 && rowAt(last + 1) !== undefined) {
		return { start: { row: first, col: 0 }, end: { row: last + 1, col: 0 } };
	}
	return { start: { row: first, col: 0 }, end: { row: last, col: lastWidth } };
}

function wordOnRow(rowAt: RowReader, row: number, col: number): SelectionRange | undefined {
	const line = rowAt(row);
	return line === undefined ? undefined : getWordSelection(line, { row, col });
}

/**
 * The word a double-click selects, joined over rows where the width cut it (a join mark, not a break at a space).
 * Columns are cells, so wide characters and combining marks keep their whole cells.
 */
function wrappedWordBounds(rowAt: RowReader, row: number, col: number): UnitBounds | undefined {
	const word = wordOnRow(rowAt, row, col);
	if (!word) return undefined;
	const start = { row, col: word.start.col };
	const end = { row, col: word.end.col };
	for (let steps = 0; steps < MAX_WRAPPED_ROWS && start.row > 0; steps++) {
		if (start.col !== continuedTextStart(rowAt(start.row) ?? "", "join")) break;
		const lastCol = textEnd(rowAt(start.row - 1) ?? "");
		const before = lastCol > 0 ? wordOnRow(rowAt, start.row - 1, lastCol - 1) : undefined;
		if (!before || before.end.col !== lastCol) break;
		start.row -= 1;
		start.col = before.start.col;
	}
	for (let steps = 0; steps < MAX_WRAPPED_ROWS; steps++) {
		if (end.col !== textEnd(rowAt(end.row) ?? "")) break;
		const next = rowAt(end.row + 1);
		const textStart = next === undefined ? undefined : continuedTextStart(next, "join");
		if (textStart === undefined) break;
		const after = wordOnRow(rowAt, end.row + 1, textStart);
		if (!after || after.start.col !== textStart) break;
		end.row += 1;
		end.col = after.end.col;
	}
	return { start, end };
}

/** The rows of the view `point` lies in, as selection reads them. */
function rowReader(point: SelectionPoint, layout: LayoutFrame | undefined, screen: readonly string[]): RowReader {
	const rows = point.scrollView ? point.scrollView.scrollHeight : screen.length;
	return (row) => (row < 0 || row >= rows ? undefined : selectionSourceLine({ ...point, row }, layout, screen));
}

/** A point of `base`'s view at another row: a row of an estimated view carries its own anchor. */
function pointAt(
	base: SelectionPoint,
	at: { row: number; col: number },
	layout: LayoutFrame | undefined,
): SelectionPoint {
	const point: SelectionPoint = { row: at.row, col: at.col };
	if (base.scrollView) point.scrollView = base.scrollView;
	const box = base.scrollView && layout ? getScrollViewBox(layout, base.scrollView) : undefined;
	const anchor = at.row === base.row ? base.anchor : box?.scrollContentAnchor?.(at.row);
	if (anchor) point.anchor = anchor;
	return point;
}

function toRange(base: SelectionPoint, bounds: UnitBounds, layout: LayoutFrame | undefined): SelectionRange {
	return { start: pointAt(base, bounds.start, layout), end: { ...pointAt(base, bounds.end, layout), boundary: true } };
}

/** The word under `point` as a selection range, joined over rows the width cut it across. */
export function wordRangeAt(
	point: SelectionPoint,
	layout: LayoutFrame | undefined,
	screen: readonly string[],
): SelectionRange | undefined {
	const bounds = wrappedWordBounds(rowReader(point, layout, screen), point.row, point.col);
	return bounds && toRange(point, bounds, layout);
}

/** The whole soft-wrapped line under `point` as a selection range. */
export function lineRangeAt(
	point: SelectionPoint,
	layout: LayoutFrame | undefined,
	screen: readonly string[],
): SelectionRange {
	return toRange(point, logicalLineBounds(rowReader(point, layout, screen), point.row), layout);
}

/**
 * The click count of a press: a press on the same word soon after the last one counts up, wrapping after three. A
 * press on a cell with no word (a space, blank row or symbol) counts by its cell, so a triple-click still selects the
 * line; the word range exists only for the double-click, which therefore selects nothing there.
 */
export function nextClick(
	previous: ClickTarget | undefined,
	point: SelectionPoint,
	word: SelectionRange | undefined,
	now = Date.now(),
): ClickTarget {
	const wordStart = word?.start.col ?? point.col;
	const wordEnd = word?.end.col ?? point.col;
	const repeated =
		previous !== undefined &&
		now - previous.timestamp <= DOUBLE_CLICK_INTERVAL_MS &&
		previous.row === point.row &&
		previous.scrollView === point.scrollView &&
		previous.wordStart === wordStart &&
		previous.wordEnd === wordEnd;
	return {
		timestamp: now,
		count: repeated ? (previous.count % 3) + 1 : 1,
		row: point.row,
		scrollView: point.scrollView,
		wordStart,
		wordEnd,
	};
}
