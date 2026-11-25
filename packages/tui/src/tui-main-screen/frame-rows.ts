import { extractCursorPosition, resolveFakeCursors } from "../tui/cursor.ts";
import { arrayWithPrefix } from "../tui/row-arrays.ts";
import { isRowFrame, type RowSource, rowCount, rowsFrom } from "../tui/row-source.ts";

/**
 * A frame without overlays, finished in one pass: fake cursors resolved, the cursor marker taken out, every row
 * finished (`finish`: line resets and clipping). Equal to `CursorRows` followed by `FinishedLines`, without an array of
 * the intermediate rows: rows the frame shares with the last one are taken from the last result, the rest are compared
 * row by row with the last input, so a frame costs what changed, not the length of the transcript.
 */
export class FrameRows {
	private input: RowSource | undefined;
	private output: string[] = [];
	/** Rows with a cursor marker, and the marker's column. */
	private marks = new Map<number, number>();
	private showHardwareCursor = false;
	private width = -1;
	private readonly finish: (line: string, width: number) => string;

	constructor(finish: (line: string, width: number) => string) {
		this.finish = finish;
	}

	/** The last result: the next one says how many leading rows it shares with it. */
	get lastOutput(): readonly string[] {
		return this.output;
	}

	reset(): void {
		this.input = undefined;
		this.output = [];
		this.marks = new Map();
		this.showHardwareCursor = false;
		this.width = -1;
	}

	/**
	 * `shared.rows`: leading rows of `input` that are the same strings as in `shared.from`, used when that is the last
	 * input. The result's `unchanged` counts the leading rows equal to the last result's. Neither `input` nor the result
	 * may change afterwards.
	 */
	apply(
		input: RowSource,
		showHardwareCursor: boolean,
		width: number,
		height: number,
		shared: { from: RowSource | undefined; rows: number },
		prepared?: ReadonlyMap<string, string>,
	): { lines: string[]; cursor: { row: number; col: number } | null; unchanged: number } {
		const last = this.input;
		const same = last !== undefined && showHardwareCursor === this.showHardwareCursor && width === this.width;
		const total = rowCount(input);
		const keep = same && shared.from === last ? Math.max(0, Math.min(shared.rows, total, this.output.length)) : 0;
		let lines = this.output;
		let marks = this.marks;
		if (keep !== total || total !== this.output.length) {
			// Without a prefix the rows are written in order into an empty array.
			lines = arrayWithPrefix(this.output, keep, total) ?? [];
			marks = new Map();
			for (const [row, col] of this.marks) if (row < keep) marks.set(row, col);
			// Rows after the first change are compared one by one with the last input at the same place. A row frame is
			// read from `keep` on; an array as it is.
			const rows = isRowFrame(input) ? rowsFrom(input, keep) : input.slice(keep);
			const before = !same || !last ? [] : isRowFrame(last) ? rowsFrom(last, keep) : last.slice(keep);
			for (let index = 0; index < rows.length; index++) {
				const row = keep + index;
				const line = rows[index];
				if (index < before.length && before[index] === line) {
					lines[row] = this.output[row];
					const col = this.marks.get(row);
					if (col !== undefined) marks.set(row, col);
					continue;
				}
				if (!line.includes("\x1b_octo:")) {
					lines[row] = prepared?.get(line) ?? this.finish(line, width);
					continue;
				}
				const [resolved] = resolveFakeCursors([line], showHardwareCursor);
				const cell = [resolved];
				const col = extractCursorPosition(cell, 1)?.col ?? -1;
				lines[row] = this.finish(cell[0], width);
				if (col >= 0) marks.set(row, col);
			}
		}
		this.input = input;
		this.output = lines;
		this.marks = marks;
		this.showHardwareCursor = showHardwareCursor;
		this.width = width;
		// The bottom-most marker in the last `height` rows.
		const viewportTop = Math.max(0, total - height);
		let cursor: { row: number; col: number } | null = null;
		for (const [row, col] of marks) {
			if (row >= viewportTop && (cursor === null || row > cursor.row)) cursor = { row, col };
		}
		return { lines, cursor, unchanged: keep };
	}
}
