/**
 * One row of the startup resource listing: `Label  count  summary`, with labels and counts in shared columns so the
 * rows line up. A long summary wraps under its own column. Expanded (ctrl+o), the row is followed by its full list,
 * indented to the same column. A row with a `source` follows it: a change repaints that row, nothing else is rebuilt.
 */

import {
	type Component,
	fitRows,
	type RowColumn,
	type StateSource,
	visibleWidth,
	wrapTextWithAnsi,
} from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { keyHint } from "../components/keybinding-hints.ts";
import type { Expandable } from "./types.ts";

export interface LoadedRowSpec {
	label: string;
	/** Item count; a row whose count is 0 draws nothing. */
	count: () => number;
	/** Collapsed text after the count; built on demand so it follows theme changes. */
	summary: () => string;
	/** Text after the count when expanded; defaults to the summary. */
	expandedSummary?: () => string;
	/** Full list shown below the row when expanded, one item per line. */
	details?: () => string;
	/** Live data the row draws from: each change repaints the row. */
	source?: StateSource<unknown>;
	/**
	 * Where the items came from (`sources`) and what did not apply (`tail`, dropped first on a narrow screen), as styled
	 * text. A row with cells is fitted to the width with the other such rows instead of wrapping its summary.
	 */
	cells?: () => { sources: string; tail?: string };
}

export interface LoadedColumns {
	label: number;
	count: number;
	/** The collapsed line of a row with cells, fitted to `width` together with its siblings; undefined for other rows. */
	fit?: (spec: LoadedRowSpec, width: number) => string | undefined;
}

const GAP = "  ";
/** The sources keep at least this many cells before the tail is dropped: a tail is never worth a cut source list. */
const MIN_SOURCES = 30;
/** Below this many cells after the columns, wrapped text starts at the left edge instead. */
const MIN_TEXT_WIDTH = 16;

/** Column widths over the rows that draw (count above 0). */
export function loadedColumns(specs: readonly LoadedRowSpec[]): LoadedColumns {
	const shown = specs.map((spec) => ({ spec, label: spec.label, count: spec.count() })).filter((row) => row.count > 0);
	const label = Math.max(0, ...shown.map((row) => row.label.length));
	const count = Math.max(0, ...shown.map((row) => String(row.count).length));
	const celled = shown.filter((row) => row.spec.cells);
	let fitted: { width: number; lines: Map<LoadedRowSpec, string> } | undefined;
	const fit = (spec: LoadedRowSpec, width: number): string | undefined => {
		if (!spec.cells) return undefined;
		if (fitted?.width !== width) {
			const cells = celled.map((row) => row.spec.cells?.());
			const { lines } = fitRows(
				celled.map((row, index) => [
					theme.bold(theme.fg("mdHeading", row.label.padEnd(label))),
					theme.fg("accent", String(row.count).padStart(count)),
					cells[index]?.sources ?? "",
					cells[index]?.tail ?? "",
				]),
				FIT_COLUMNS,
				width,
				{ gap: GAP, minFlex: MIN_SOURCES },
			);
			fitted = { width, lines: new Map(celled.map((row, index) => [row.spec, lines[index] ?? ""])) };
		}
		return fitted.lines.get(spec);
	};
	return { label, count, fit };
}

/** Label and count stay; the sources take what is left and are cut with an ellipsis; the tail goes first. */
const FIT_COLUMNS: readonly RowColumn[] = [
	{ priority: 3 },
	{ priority: 3, align: "right", max: 4 },
	{ priority: 2, flex: true },
	{ priority: 1 },
];

/** `(ctrl+o to expand)`, as the collapsed bash output and other expandable views word it. */
export const expandHint = (): string =>
	`${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;

/** Wraps `text` into `width - indent` cells and indents every row after the first by `indent`. */
function wrapAfter(text: string, width: number, indent: number): string[] {
	const room = width - indent;
	if (room < MIN_TEXT_WIDTH) return wrapTextWithAnsi(text, Math.max(1, width));
	return wrapTextWithAnsi(text, room).map((part, index) => (index === 0 ? part : " ".repeat(indent) + part));
}

export class LoadedRow implements Component, Expandable {
	private readonly spec: LoadedRowSpec;
	private readonly columns: () => LoadedColumns;
	private expanded: boolean;
	private cached: { key: string; lines: string[] } | undefined;
	private readonly unsubscribe: (() => void) | undefined;

	/** `columns` is read at each draw, so a live row that changes the widths realigns its siblings. */
	constructor(spec: LoadedRowSpec, columns: () => LoadedColumns, expanded: boolean, requestRender?: () => void) {
		this.spec = spec;
		this.columns = columns;
		this.expanded = expanded;
		this.unsubscribe = spec.source?.subscribe(() => {
			this.invalidate();
			requestRender?.();
		});
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.invalidate();
	}

	invalidate(): void {
		this.cached = undefined;
	}

	dispose(): void {
		this.unsubscribe?.();
	}

	render(width: number): string[] {
		const { spec } = this;
		const columns = this.columns();
		const key = `${width}:${columns.label}:${columns.count}`;
		if (this.cached?.key === key) return this.cached.lines;
		const count = spec.count();
		if (count === 0) {
			this.cached = { key, lines: [] };
			return [];
		}
		const head =
			theme.bold(theme.fg("mdHeading", spec.label.padEnd(columns.label))) +
			GAP +
			theme.fg("accent", String(count).padStart(columns.count)) +
			GAP;
		const indent = visibleWidth(head);
		const summary = this.expanded && spec.expandedSummary ? spec.expandedSummary() : spec.summary();
		const fitted = columns.fit?.(spec, width);
		const [first = "", ...rest] = fitted === undefined ? wrapAfter(summary, width, indent) : [];
		const lines = fitted === undefined ? [head + first, ...rest] : [fitted];
		if (this.expanded && spec.details) {
			for (const line of spec.details().split("\n")) {
				// Detail lines carry their own nesting; keep it, shifted under the summary column.
				const plain = stripAnsi(line);
				const body = line.replace(/^((?:\x1b\[[0-9;]*m)*) +/, "$1");
				const nest = plain.length - plain.trimStart().length;
				const lead = Math.max(0, indent + nest - 2);
				const wrapped = wrapAfter(body, width, lead);
				lines.push(
					...wrapped.map(
						(part, index) => (index === 0 && width - lead >= MIN_TEXT_WIDTH ? " ".repeat(lead) : "") + part,
					),
				);
			}
		}
		this.cached = { key, lines };
		return lines;
	}
}
