import { extractCursorPosition, resolveFakeCursors } from "../tui/cursor.ts";

/** One frame's rows: as rendered, with fake cursors resolved, without cursor markers, and each row's marker column or -1. */
interface ResolvedRows {
	inputs: string[];
	resolved: string[];
	stripped: string[];
	cursorCols: number[];
}

/**
 * Fake-cursor resolution and cursor-marker extraction of each row, remembered from the last frame like `FinishedLines`:
 * a row that came back unchanged costs one comparison, so a keystroke in a long transcript does not rescan every row.
 * The results equal `resolveFakeCursors` followed by `extractCursorPosition` over the whole frame.
 */
export class CursorRows {
	private last: ResolvedRows = { inputs: [], resolved: [], stripped: [], cursorCols: [] };
	private showHardwareCursor = false;

	private resolveRows(lines: readonly string[], showHardwareCursor: boolean): ResolvedRows {
		const last = this.last;
		const same = showHardwareCursor === this.showHardwareCursor;
		const rows: ResolvedRows = { inputs: lines.slice(), resolved: [], stripped: [], cursorCols: [] };
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index];
			if (same && last.inputs[index] === line) {
				rows.resolved.push(last.resolved[index]);
				rows.stripped.push(last.stripped[index]);
				rows.cursorCols.push(last.cursorCols[index]);
				continue;
			}
			const [resolved] = resolveFakeCursors([line], showHardwareCursor);
			const stripped = [resolved];
			rows.resolved.push(resolved);
			rows.cursorCols.push(extractCursorPosition(stripped, 1)?.col ?? -1);
			rows.stripped.push(stripped[0]);
		}
		this.last = rows;
		this.showHardwareCursor = showHardwareCursor;
		return rows;
	}

	/**
	 * `resolveFakeCursors`, then `composite` (overlays) when given, then `extractCursorPosition`: the rows without
	 * markers and the bottom-most marker in the last `height` rows. The caller must not change the returned rows.
	 */
	resolve(
		lines: readonly string[],
		showHardwareCursor: boolean,
		height: number,
		composite?: (resolved: string[]) => string[],
	): { lines: readonly string[]; cursor: { row: number; col: number } | null } {
		const rows = this.resolveRows(lines, showHardwareCursor);
		if (composite) {
			// Overlays can draw over a marker or bring their own: extract from the composited frame.
			const composited = composite(rows.resolved.slice());
			return { cursor: extractCursorPosition(composited, height), lines: composited };
		}
		const viewportTop = Math.max(0, lines.length - height);
		for (let row = lines.length - 1; row >= viewportTop; row--) {
			const col = rows.cursorCols[row];
			if (col >= 0) return { lines: rows.stripped, cursor: { row, col } };
		}
		return { lines: rows.stripped, cursor: null };
	}
}
