/**
 * Reading a few rows of a scroll view's content without joining all of them: a plain container hands over a row frame
 * (its children's rows, nested), and a frame paints only the rows in view.
 */

import { isRowFrame, type RowSource, rowCount } from "../tui/row-source.ts";

/** The child of `frame` whose rows hold `row`: the last one starting at or before it. */
function childAt(offsets: readonly number[], count: number, row: number): number {
	let low = 0;
	let high = count - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if (offsets[middle] <= row) low = middle;
		else high = middle - 1;
	}
	return low;
}

/** Row `row` of `source`, or undefined outside it. */
export function rowAt(source: RowSource, row: number): string | undefined {
	let current = source;
	let at = row;
	if (at < 0 || at >= rowCount(current)) return undefined;
	while (isRowFrame(current)) {
		if (current.lines) return current.lines[at];
		const index = childAt(current.offsets, current.sources.length, at);
		at -= current.offsets[index];
		current = current.sources[index];
	}
	return current[at];
}

/** Rows `[from, to)` of `source`, clamped to it. */
export function rowsBetween(source: RowSource, from: number, to: number): string[] {
	const start = Math.max(0, from);
	const end = Math.min(rowCount(source), to);
	const rows: string[] = [];
	if (end <= start) return rows;
	const visit = (part: RowSource, first: number, last: number): void => {
		if (!isRowFrame(part)) {
			for (let row = first; row < last; row++) rows.push(part[row]);
			return;
		}
		if (part.lines) {
			for (let row = first; row < last; row++) rows.push(part.lines[row]);
			return;
		}
		const count = part.sources.length;
		for (let index = childAt(part.offsets, count, first); index < count && part.offsets[index] < last; index++) {
			const offset = part.offsets[index];
			const length = part.offsets[index + 1] - offset;
			const childFirst = Math.max(0, first - offset);
			const childLast = Math.min(length, last - offset);
			if (childLast > childFirst) visit(part.sources[index], childFirst, childLast);
		}
	};
	visit(source, start, end);
	return rows;
}
