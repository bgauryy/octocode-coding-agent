/**
 * A container's rows without the copy: its children's row arrays, or nested containers' row frames, in order.
 *
 * Joining a long transcript's rows into one array costs a copy of every row on every change, and a copy of that copy
 * in each container above it. A container that renders into its parent hands over a row frame instead; only a caller
 * that needs an array (`render`) makes one, starting from the rows its last array shares with this frame.
 */

import { arrayWithPrefix } from "./row-arrays.ts";

export interface RowFrame {
	/** Each child's rows. */
	readonly sources: readonly RowSource[];
	/** Row where each child starts; the last entry is the total. */
	readonly offsets: readonly number[];
	/** The frame this one replaced, until a newer one replaces this one; and how many leading rows the two share. */
	basis: RowFrame | undefined;
	readonly sharedRows: number;
	/** The rows as one array, once a caller asked for it. Never changed after it is made. */
	lines: string[] | undefined;
}

export type RowSource = readonly string[] | RowFrame;

export function isRowFrame(source: RowSource): source is RowFrame {
	return !Array.isArray(source);
}

export function rowCount(source: RowSource): number {
	return isRowFrame(source) ? source.offsets[source.offsets.length - 1] : source.length;
}

/** The child whose rows hold row `row` of the frame (the last child starting at or before it). */
function childAt(frame: RowFrame, row: number): number {
	let low = 0;
	let high = frame.sources.length - 1;
	while (low < high) {
		const middle = (low + high + 1) >> 1;
		if (frame.offsets[middle] <= row) low = middle;
		else high = middle - 1;
	}
	return low;
}

/** Write the rows of `source` from row `from` on into `into`, starting at index `at`; returns the index after them. */
function copyRows(source: RowSource, from: number, into: string[], at: number): number {
	let next = at;
	if (!isRowFrame(source)) {
		for (let row = from; row < source.length; row++) into[next++] = source[row];
		return next;
	}
	if (source.sources.length === 0) return next;
	for (let index = childAt(source, from); index < source.sources.length; index++) {
		next = copyRows(source.sources[index], Math.max(0, from - source.offsets[index]), into, next);
	}
	return next;
}

/** The rows of `source` from row `from` on, as a new array. */
export function rowsFrom(source: RowSource, from: number): string[] {
	// Written in order from index 0, so the array grows as a plain list.
	const rows: string[] = [];
	copyRows(source, from, rows, 0);
	return rows;
}

/** The frame's rows as one array, made once: rows shared with the frame it replaced come from that frame's array. */
export function frameLines(frame: RowFrame): string[] {
	if (frame.lines) return frame.lines;
	const total = rowCount(frame);
	const before = frame.basis?.lines;
	const keep = before ? Math.min(frame.sharedRows, before.length, total) : 0;
	// Without a prefix `keep` is 0 and the rows are written in order into an empty array.
	const lines = (before ? arrayWithPrefix(before, keep, total) : undefined) ?? [];
	copyRows(frame, keep, lines, keep);
	frame.lines = lines;
	return lines;
}

/** Leading rows of `after` that are the same strings as in `before`, as far as row frames know it. */
export function sharedRowsOf(before: RowSource | undefined, after: RowSource): number {
	if (before === undefined) return 0;
	if (before === after) return rowCount(after);
	if (isRowFrame(after) && after.basis === before) return Math.min(after.sharedRows, rowCount(before), rowCount(after));
	return 0;
}
