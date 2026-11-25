import { extractCursorPosition, resolveFakeCursors } from "../tui/cursor.ts";
import { arrayWithPrefix } from "../tui/row-arrays.ts";

/** A row that held a cursor marker: the row with the marker (resolved) and the marker's column. */
interface MarkedRow {
	resolved: string;
	col: number;
}

/** One frame's rows as rendered, without cursor markers, and the rows that had a marker. */
interface ResolvedRows {
	inputs: readonly string[];
	stripped: string[];
	marked: Map<number, MarkedRow>;
}

/**
 * Fake-cursor resolution and cursor-marker extraction of each row, remembered from the last frame like `FinishedLines`:
 * a row that came back unchanged costs one comparison, so a keystroke in a long transcript does not rescan every row,
 * and rows the caller vouches for (`unchanged`) cost nothing. The results equal `resolveFakeCursors` followed by
 * `extractCursorPosition` over the whole frame.
 */
export class CursorRows {
	private last: ResolvedRows = { inputs: [], stripped: [], marked: new Map() };
	private showHardwareCursor = false;
	/** The last call returned its stripped rows, not an overlay composite: the next result may say what it shares. */
	private returnedStripped = false;

	reset(): void {
		this.last = { inputs: [], stripped: [], marked: new Map() };
		this.showHardwareCursor = false;
		this.returnedStripped = false;
	}

	/** `unchanged`: leading rows of `lines` that are the same strings as in the lines of the last call. */
	private resolveRows(lines: readonly string[], showHardwareCursor: boolean, unchanged: number): ResolvedRows {
		const last = this.last;
		const same = showHardwareCursor === this.showHardwareCursor;
		const keep = same ? Math.max(0, Math.min(unchanged, last.inputs.length, lines.length)) : 0;
		// Every row is the last frame's: so are the results.
		if (keep === lines.length && keep === last.inputs.length) {
			this.last = { ...last, inputs: lines };
			return this.last;
		}
		// Without a prefix the rows are written in order into an empty array.
		const stripped = arrayWithPrefix(last.stripped, keep, lines.length) ?? [];
		const marked = new Map<number, MarkedRow>();
		for (const [row, mark] of last.marked) if (row < keep) marked.set(row, mark);
		for (let index = keep; index < lines.length; index++) {
			const line = lines[index];
			if (same && last.inputs[index] === line) {
				stripped[index] = last.stripped[index];
				const mark = last.marked.get(index);
				if (mark) marked.set(index, mark);
				continue;
			}
			const [resolved] = resolveFakeCursors([line], showHardwareCursor);
			const row = [resolved];
			const col = extractCursorPosition(row, 1)?.col ?? -1;
			stripped[index] = row[0];
			if (col >= 0) marked.set(index, { resolved, col });
		}
		// The caller hands over rows it never changes afterwards (a container's result), so they are kept by reference.
		const rows: ResolvedRows = { inputs: lines, stripped, marked };
		this.last = rows;
		this.showHardwareCursor = showHardwareCursor;
		return rows;
	}

	/**
	 * `resolveFakeCursors`, then `composite` (overlays) when given, then `extractCursorPosition`: the rows without
	 * markers and the bottom-most marker in the last `height` rows. The caller must not change the returned rows, nor
	 * `lines` afterwards.
	 */
	resolve(
		lines: readonly string[],
		showHardwareCursor: boolean,
		height: number,
		composite?: (resolved: string[]) => string[],
	): { lines: readonly string[]; cursor: { row: number; col: number } | null } {
		const { lines: rows, cursor } = this.resolveFrom(lines, showHardwareCursor, height, composite, 0);
		return { lines: rows, cursor };
	}

	/**
	 * `resolve`, where the first `unchanged` rows of `lines` are the same strings as in the last call's `lines`. The
	 * result's `unchanged` counts the leading rows of the result that are the same as in the last call's result.
	 */
	resolveFrom(
		lines: readonly string[],
		showHardwareCursor: boolean,
		height: number,
		composite: ((resolved: string[]) => string[]) | undefined,
		unchanged: number,
	): { lines: readonly string[]; cursor: { row: number; col: number } | null; unchanged: number } {
		const comparable = this.returnedStripped && showHardwareCursor === this.showHardwareCursor;
		const keep = comparable ? Math.min(unchanged, this.last.inputs.length) : 0;
		const rows = this.resolveRows(lines, showHardwareCursor, unchanged);
		this.returnedStripped = !composite;
		if (composite) {
			// Overlays can draw over a marker or bring their own: extract from the composited frame.
			const resolved = rows.stripped.slice();
			for (const [row, mark] of rows.marked) resolved[row] = mark.resolved;
			const composited = composite(resolved);
			return { cursor: extractCursorPosition(composited, height), lines: composited, unchanged: 0 };
		}
		const viewportTop = Math.max(0, lines.length - height);
		let cursor: { row: number; col: number } | null = null;
		for (const [row, mark] of rows.marked) {
			if (row >= viewportTop && (cursor === null || row > cursor.row)) cursor = { row, col: mark.col };
		}
		return { lines: rows.stripped, cursor, unchanged: Math.max(0, Math.min(keep, lines.length)) };
	}
}
