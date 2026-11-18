import { getActiveOsc8Close } from "../utils/ansi-tracker.ts";
import { truncateToWidth } from "../utils/truncate.ts";
import { visibleWidth } from "../utils/width.ts";
import { wrapTextWithAnsi } from "../utils/wrap.ts";

/** Starts a wrapped cell's continuation line. */
export const WRAP_MARK = "↳ ";
const WRAP_MARK_WIDTH = 2;

/**
 * One column of a row grid. Columns are dropped by `priority` (the lowest goes first) when the line is too narrow; the
 * `flex` column is the one that is cut with an ellipsis instead of being dropped.
 */
export interface RowColumn {
	/** Higher stays longer. Ties drop the rightmost column first. */
	priority: number;
	/** The column that takes the width the others leave and is truncated when it still does not fit. At most one. */
	flex?: boolean;
	/** Right-align the cells (numbers, counts). */
	align?: "left" | "right";
	/** Cap the natural width, so one long cell cannot push every row's later columns off the line. */
	max?: number;
	/**
	 * `cut` (default) ends a cell that does not fit in an ellipsis; `wrap` continues it on extra lines that start at the
	 * column with `↳ `, the other columns left blank there. A column narrower than 3 cells cuts instead.
	 */
	overflow?: "cut" | "wrap";
}

export interface RowFitOptions {
	/** Between columns (default one space). */
	gap?: string;
	/** What a truncated cell ends in (default `…`). */
	ellipsis?: string;
	/** The least width the flex column keeps before a lower-priority column is dropped (default 12). */
	minFlex?: number;
}

export interface RowFit {
	/**
	 * The lines, none wider than `width`: one per row, plus a row's continuation lines after it when a `wrap` column
	 * overflowed. Cells are padded so the columns align across rows.
	 */
	lines: string[];
	/** For each line, the index of the row it belongs to. */
	lineRows: number[];
	/** Which of the columns were kept, by index. */
	kept: boolean[];
}

/**
 * Fits rows of cells into `width` columns. Every cell is a string that may carry ANSI styling; a column with no text in any
 * row takes no room. The columns share one width across the rows, so they line up; the widths come from
 * `visibleWidth` and cuts from `truncateToWidth`, so wide characters (CJK, emoji) never split and no line overflows.
 * When the line is too narrow, the lowest-priority column goes first until the flex column keeps `minFlex` columns;
 * a grid without a flex column drops columns until it fits and cuts what is left. A column with `overflow: "wrap"`
 * continues a cell that does not fit on extra lines instead of cutting it.
 */
export function fitRows(
	rows: readonly (readonly string[])[],
	columns: readonly RowColumn[],
	width: number,
	options: RowFitOptions = {},
): RowFit {
	const gap = options.gap ?? " ";
	const ellipsis = options.ellipsis ?? "…";
	const gapWidth = visibleWidth(gap);
	const flexIndex = columns.findIndex((column) => column.flex);
	const limit = Math.max(0, Math.floor(width));

	const natural = columns.map((column, index) => {
		const widest = Math.max(0, ...rows.map((row) => visibleWidth(row[index] ?? "")));
		return column.max === undefined || column.flex ? widest : Math.min(widest, column.max);
	});
	const active = columns.map((_, index) => natural[index] > 0);
	const used = (): number[] => active.flatMap((on, index) => (on ? [index] : []));
	const total = () => {
		const shown = used();
		return shown.reduce((sum, index) => sum + natural[index], 0) + gapWidth * Math.max(0, shown.length - 1);
	};
	const floor = flexIndex >= 0 ? Math.min(natural[flexIndex], options.minFlex ?? 12) : 0;
	const needed = () => total() - (flexIndex >= 0 && active[flexIndex] ? natural[flexIndex] - floor : 0);
	while (needed() > limit) {
		const droppable = used().filter((index) => index !== flexIndex);
		if (droppable.length === 0) break;
		const lowest = droppable.reduce((low, index) => (columns[index].priority <= columns[low].priority ? index : low));
		active[lowest] = false;
	}

	const shown = used();
	const widths = new Map(shown.map((index) => [index, natural[index]]));
	if (flexIndex >= 0 && active[flexIndex]) {
		const others = total() - natural[flexIndex];
		widths.set(flexIndex, Math.max(0, Math.min(natural[flexIndex], limit - others)));
	} else if (shown.length === 1 && total() > limit) widths.set(shown[0], limit);

	const lines: string[] = [];
	const lineRows: number[] = [];
	rows.forEach((row, rowIndex) => {
		let line = "";
		let start = 0;
		const continued: { start: number; parts: string[] }[] = [];
		shown.forEach((index, position) => {
			const cell = row[index] ?? "";
			const room = widths.get(index) ?? 0;
			const wraps = columns[index].overflow === "wrap" && room > WRAP_MARK_WIDTH && visibleWidth(cell) > room;
			const [first, ...rest] = wraps ? wrapCell(cell, room) : [truncateToWidth(cell, room, ellipsis)];
			if (rest.length > 0) continued.push({ start: start + (position === 0 ? 0 : gapWidth), parts: rest });
			const padding = " ".repeat(Math.max(0, room - visibleWidth(first)));
			const last = position === shown.length - 1;
			const text = columns[index].align === "right" ? `${padding}${first}` : last ? first : `${first}${padding}`;
			line += position === 0 ? text : `${gap}${text}`;
			start += (position === 0 ? 0 : gapWidth) + room;
		});
		lines.push(line);
		lineRows.push(rowIndex);
		for (const extra of continuationLines(continued)) {
			lines.push(extra);
			lineRows.push(rowIndex);
		}
	});
	return { lines, lineRows, kept: columns.map((_, index) => active[index]) };
}

/** A cell that overflows `room`: its first line at `room`, the rest re-wrapped to leave space for the mark. */
function wrapCell(cell: string, room: number): string[] {
	const [first = "", ...rest] = wrapTextWithAnsi(cell, room);
	if (rest.length === 0) return [first];
	const tail = wrapTextWithAnsi(rest.join(" "), room - WRAP_MARK_WIDTH);
	return [closed(first, room), ...tail.map((part) => closed(part, room - WRAP_MARK_WIDTH))];
}

/** A wrapped part within `room`, its open link and styles closed so they end with the part, not in the next column. */
function closed(part: string, room: number): string {
	const fitted = truncateToWidth(part, room, "");
	return fitted.includes("\x1b") ? `${fitted}${getActiveOsc8Close(fitted)}\x1b[0m` : fitted;
}

/** The continuation lines of one row: wrapped columns side by side, each part behind `↳ ` at its column. */
function continuationLines(continued: { start: number; parts: string[] }[]): string[] {
	const count = Math.max(0, ...continued.map((column) => column.parts.length));
	const lines: string[] = [];
	for (let i = 0; i < count; i++) {
		let line = "";
		let at = 0;
		for (const column of continued) {
			const part = column.parts[i];
			if (part === undefined) continue;
			line += " ".repeat(Math.max(0, column.start - at)) + WRAP_MARK + part;
			at = column.start + WRAP_MARK_WIDTH + visibleWidth(part);
		}
		lines.push(line);
	}
	return lines;
}
