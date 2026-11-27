/**
 * One row of the startup resource listing: `Label  count  summary`, with labels and counts in shared columns so the
 * rows line up. A long summary wraps under its own column. Expanded (ctrl+o), the row is followed by its full list,
 * indented to the same column. A row with a `source` follows it: a change repaints that row, nothing else is rebuilt.
 */

import { type Component, type StateSource, visibleWidth, wrapTextWithAnsi } from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { badge, type BadgeState } from "../../../theme/page-kit.ts";
import { fitCell } from "../../../theme/columns.ts";
import type { Expandable } from "./types.ts";

export interface LoadedRowSpec {
	label: string;
	state?: () => BadgeState;
	/** Item count; a row whose count is 0 draws nothing unless `showZero` is set. */
	count: () => number;
	/** Draw the row at count 0 too, for a kind whose absence is worth seeing (`Hooks  0`). */
	showZero?: boolean;
	/** Draw the row only when the listing is expanded (ctrl+o). */
	expandedOnly?: boolean;
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
	/**
	 * The collapsed text as lines that fit `room` cells after the label and count, for a row that chooses what to drop
	 * itself instead of being wrapped or cut. Later lines are indented under the first.
	 */
	fitSummary?: (room: number) => string[];
}

export interface LoadedColumns {
	label: number;
	count: number;
	/** The collapsed line of a row with cells, fitted to `width` together with its siblings; undefined for other rows. */
	fit?: (spec: LoadedRowSpec, width: number) => string | undefined;
}

const GAP = "  ";
/** Below this many cells after the columns, wrapped text starts at the left edge instead. */
const MIN_TEXT_WIDTH = 16;

/** Column widths over the rows that draw (count above 0). */
export function loadedColumns(specs: readonly LoadedRowSpec[]): LoadedColumns {
	const shown = specs
		.map((spec) => ({ spec, label: spec.label, count: spec.count() }))
		.filter((row) => row.count > 0 || row.spec.showZero);
	const label = Math.max(0, ...shown.map((row) => row.label.length));
	const count = Math.max(0, ...shown.map((row) => String(row.count).length));
	return { label, count };
}

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
		if ((count === 0 && !spec.showZero) || (spec.expandedOnly && !this.expanded)) {
			this.cached = { key, lines: [] };
			return [];
		}
		const status = badge(spec.state?.() ?? "ready");
		// The glyph sits beside the count; the legend line names each glyph's word.
		const head =
			theme.bold(theme.fg("mdHeading", fitCell(spec.label, columns.label))) +
			GAP +
			theme.fg(status.tone, status.glyph) +
			" " +
			theme.fg("accent", String(count).padStart(columns.count)) +
			GAP;
		const indent = visibleWidth(head);
		const summary = this.expanded && spec.expandedSummary ? spec.expandedSummary() : spec.summary();
		const own =
			spec.fitSummary && !(this.expanded && spec.expandedSummary) ? spec.fitSummary(width - indent) : undefined;
		const [first = "", ...rest] =
			own?.map((line, index) => (index === 0 ? line : " ".repeat(indent) + line)) ?? wrapAfter(summary, width, indent);
		const lines =
			width - indent < MIN_TEXT_WIDTH ? wrapTextWithAnsi(head + summary, Math.max(1, width)) : [head + first, ...rest];
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
