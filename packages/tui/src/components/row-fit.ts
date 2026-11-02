import { truncateToWidth } from "../utils/truncate.ts";
import { visibleWidth } from "../utils/width.ts";

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
	/** One line per row, none wider than `width`. Cells are padded so the columns align across rows. */
	lines: string[];
	/** Which of the columns were kept, by index. */
	kept: boolean[];
}

/**
 * Fits rows of cells into `width` columns. Every cell is a string that may carry ANSI styling; a column with no text in any
 * row takes no room. The columns share one width across the rows, so they line up; the widths come from
 * `visibleWidth` and cuts from `truncateToWidth`, so wide characters (CJK, emoji) never split and no line overflows.
 * When the line is too narrow, the lowest-priority column goes first until the flex column keeps `minFlex` columns;
 * a grid without a flex column drops columns until it fits and cuts what is left.
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

	const lines = rows.map((row) => {
		let line = "";
		shown.forEach((index, position) => {
			const cell = row[index] ?? "";
			const room = widths.get(index) ?? 0;
			const fitted = truncateToWidth(cell, room, ellipsis);
			const padding = " ".repeat(Math.max(0, room - visibleWidth(fitted)));
			const last = position === shown.length - 1;
			const text = columns[index].align === "right" ? `${padding}${fitted}` : last ? fitted : `${fitted}${padding}`;
			line += position === 0 ? text : `${gap}${text}`;
		});
		return line;
	});
	return { lines, kept: columns.map((_, index) => active[index]) };
}
