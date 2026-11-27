import { padToWidth, truncateToWidth as truncateStyled, visibleWidth } from "@octocodeai/octocode-tui";

/**
 * Text laid out in columns for a width, shared by every command that prints a table or a label/value list as plain
 * text. A row is never wrapped: when the rows are wider than `width`, the widest column that may flex is cut with an
 * ellipsis until they fit, and a row that is still too wide is cut at the edge. Without a `width` nothing is cut.
 */

export interface ColumnsOptions {
	/** Terminal columns available to a row, indent included. Unset: rows keep their natural width. */
	width?: number;
	/** Spaces between columns. Default 2. */
	gap?: number;
	/** Text before every row. Default none. */
	indent?: string;
	/** Columns padded on the left instead (numbers). */
	right?: readonly number[];
	/** Least width of each column, by index: rows printed apart can keep the same columns. */
	min?: readonly number[];
	/** Columns that may be cut to fit, by index. Default: all but the last column, then the last. */
	flex?: readonly number[];
}

/** Cuts like the terminal kit, but text that carried no escape codes comes back without the reset codes the cut adds. */
function truncateToWidth(text: string, width: number): string {
	const cut = truncateStyled(text, width);
	return text.includes("\x1b") ? cut : cut.replaceAll("\x1b[0m", "");
}

/** The narrowest a cut column gets: a few characters and the ellipsis. */
const CUT_FLOOR = 4;

/** `text` as exactly `width` terminal columns: cut with an ellipsis when wider, padded when narrower. */
export function fitCell(text: string, width: number, align: "left" | "right" = "left"): string {
	return padToWidth(truncateToWidth(text, width), width, align);
}

function naturalWidths(rows: readonly (readonly string[])[], min: readonly number[]): number[] {
	const count = Math.max(0, ...rows.map((row) => row.length));
	return Array.from({ length: count }, (_, column) =>
		Math.max(min[column] ?? 0, ...rows.map((row) => visibleWidth(row[column] ?? ""))),
	);
}

/** The width of each column after cutting the widest flexible one until the row fits `width`. */
function columnWidths(rows: readonly (readonly string[])[], options: ColumnsOptions = {}): number[] {
	const { width, gap = 2, indent = "", min = [], flex } = options;
	const widths = naturalWidths(rows, min);
	if (width === undefined || widths.length === 0) return widths;
	const budget = width - visibleWidth(indent) - gap * (widths.length - 1);
	const candidates = flex ?? widths.map((_, column) => column);
	const floors = (column: number) => Math.min(widths[column], CUT_FLOOR);
	let excess = widths.reduce((sum, each) => sum + each, 0) - budget;
	while (excess > 0) {
		let widest = -1;
		for (const column of candidates)
			if (widths[column] > floors(column) && (widest < 0 || widths[column] > widths[widest])) widest = column;
		if (widest < 0) break;
		const cut = Math.min(excess, widths[widest] - floors(widest));
		widths[widest] -= cut;
		excess -= cut;
	}
	return widths;
}

/**
 * One line per row: cells padded to their column (the last column is left as it is unless it is right-aligned), joined
 * by `gap` spaces, after `indent`, with trailing spaces removed. Cells hold no line breaks.
 */
export function columnRows(rows: readonly (readonly string[])[], options: ColumnsOptions = {}): string[] {
	const { width, gap = 2, indent = "", right = [] } = options;
	const widths = columnWidths(rows, options);
	const last = widths.length - 1;
	return rows.map((row) => {
		const line = widths
			.map((columnWidth, column) => {
				const cell = row[column] ?? "";
				const align = right.includes(column) ? "right" : "left";
				if (column === last && align === "left")
					return visibleWidth(cell) > columnWidth ? truncateToWidth(cell, columnWidth) : cell;
				return fitCell(cell, columnWidth, align);
			})
			.join(" ".repeat(gap));
		const text = `${indent}${line}`.trimEnd();
		return width === undefined ? text : truncateToWidth(text, width);
	});
}

/**
 * Label/value rows: labels padded to the longest, then the value. A value of several lines keeps its lines under the
 * first one. A value too wide for `width` is cut on each of its lines.
 */
export function labelValueRows(pairs: readonly (readonly [string, string])[], options: ColumnsOptions = {}): string[] {
	const { width, gap = 2, indent = "", min = [] } = options;
	const labelWidth = Math.max(min[0] ?? 0, ...pairs.map(([label]) => visibleWidth(label)));
	const valueWidth = width === undefined ? undefined : Math.max(1, width - visibleWidth(indent) - labelWidth - gap);
	const lead = `${indent}${" ".repeat(labelWidth + gap)}`;
	return pairs.flatMap(([label, value]) =>
		value.split("\n").map((line, index) => {
			const shown = valueWidth === undefined ? line : truncateToWidth(line, valueWidth);
			return (
				index === 0 ? `${indent}${padToWidth(label, labelWidth)}${" ".repeat(gap)}${shown}` : `${lead}${shown}`
			).trimEnd();
		}),
	);
}
