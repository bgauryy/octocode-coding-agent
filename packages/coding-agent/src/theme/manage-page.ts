/**
 * One page of the list → detail → action pattern (commands design §3): a title, optional fact rows, sections of
 * selectable rows with a status badge, and one key-hint line. The list page and the detail page are the same component;
 * a detail page passes `facts` and a single "Actions" section.
 */

import {
	type Component,
	type Focusable,
	getKeybindings,
	ListView,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@octocodeai/octocode-tui";
import { ruleLine } from "./dynamic-border.ts";
import { selectedText } from "./gradients.ts";
import { theme } from "./theme.ts";
import { type BadgeState, type EnterVerb, legend, pageHints, positionLabel } from "./page-kit.ts";
import { cursorMark, hintLine, keyText, type RankedHint, renderHintLine } from "./theme-tui-helpers.ts";

export interface PageRow {
	id: string;
	name: string;
	/** Muted text after the name. */
	detail?: string;
	/** Short state word at the right edge (`enabled`, `on`, `off`). */
	badge?: string;
	tone?: "success" | "muted" | "warning" | "error";
	/**
	 * Single keys that work on this row (key → verb). The footer shows the selected row's keys, and a page-level key
	 * the row does not declare does nothing. A page where no row declares keys falls back to `ManagePageOptions.keys`.
	 */
	keys?: Readonly<Record<string, string>>;
}

export interface PageSection {
	heading: string;
	rows: readonly PageRow[];
	/** Shown muted, not selectable, when the section has no rows. */
	empty?: string;
}

interface PageFact {
	label: string;
	value: string;
}

export interface ManagePageOptions {
	title: string;
	/** Muted lines under the list, above the key hints. */
	notes?: readonly string[];
	/** Problems to show under the list in the error colour, above the notes. */
	alerts?: readonly string[];
	facts?: readonly PageFact[];
	sections: readonly PageSection[];
	/** Explicit footer hints. Omit them: the footer is `pageHints` for the selected row. */
	hints?: readonly RankedHint[];
	/** The page was opened from another page: Escape reads `back`, at the root `close`. Used when `hints` is omitted. */
	nested?: boolean;
	/** What Enter does, for the derived footer; defaults to `open` on a list and `run` on a detail page. */
	enter?: EnterVerb;
	/** States named in a legend line under the list. */
	legend?: readonly BadgeState[];
	/** Terminal height the body is sized to; defaults to the process terminal. */
	viewportRows?(): number;
	/** Row to select first. */
	initialId?: string;
	/** Page-wide single keys (`e`) for rows that declare none of their own; prefer `PageRow.keys`. */
	keys?: readonly string[];
	onSelect(id: string): void;
	/** Called with the row's id when the selection moves, so a page rebuilt later can reopen on it. */
	onHighlight?(id: string): void;
	onKey?(key: string, id: string): void;
	/** Sees each key before the page does; true when it took the key (a page that closes on a typed `/`). */
	onInput?(data: string): boolean;
	onCancel(): void;
}

/**
 * Wraps `text` (which starts with `indent` spaces) so each continuation line keeps that indent. When the indent leaves
 * no room for text, the indent is dropped so no line is wider than `width`.
 */
function wrapIndented(text: string, width: number, indent: number): string[] {
	if (width <= indent) return wrapTextWithAnsi(text.slice(indent), Math.max(1, width));
	const room = width - indent;
	const [first = "", ...rest] = wrapTextWithAnsi(text.slice(indent), room);
	return [`${" ".repeat(indent)}${first}`, ...rest.map((line) => `${" ".repeat(indent)}${line}`)];
}

/** A selectable row with the section headings and empty notes drawn above it. */
interface Item {
	row: PageRow;
	above: Line[];
}

type Line = { heading: string } | { note: string };

const MAX_ROWS = 14;
/** The name column's cap: 24 columns, or a third of a wider terminal so long ids (model ids) stay aligned. */
const nameCap = (width: number) => Math.max(24, Math.floor(width / 3));

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/**
 * The page: rows on a `ListView` (the `›` cursor, page keys that move it, an `a–b/total` foot counting rows, the wheel
 * and a click that selects; a page never acts on a click). Section headings ride above their first row; sections
 * after the last row are drawn under the list.
 */
export class ManagePageComponent implements Component, Focusable {
	private readonly selectable: PageRow[];
	private readonly options: ManagePageOptions;
	private readonly list: ListView<Item>;
	/** Headings and empty notes after the last selectable row. */
	private readonly trailing: Line[] = [];
	private width = 80;
	/** Lines above the list in the last render, to place mouse rows. */
	private listTop = 0;
	/** First fact line shown when the facts do not fit; page keys scroll them while every row is in view. */
	private factScroll = 0;
	private factsOverflow = false;
	private factPage = 1;
	focused = false;

	constructor(options: ManagePageOptions) {
		this.options = options;
		this.selectable = options.sections.flatMap((section) => [...section.rows]);
		const items: Item[] = [];
		let pending: Line[] = [];
		for (const section of options.sections) {
			pending.push({ heading: section.heading });
			if (section.rows.length === 0 && section.empty) pending.push({ note: section.empty });
			for (const row of section.rows) {
				items.push({ row, above: pending });
				pending = [];
			}
		}
		this.trailing = pending;
		const longestName = Math.max(1, ...this.selectable.map((row) => visibleWidth(row.name)));
		this.list = new ListView<Item>({
			items,
			maxRows: MAX_ROWS,
			mark: false,
			clickConfirms: false,
			theme: {
				cursor: (text) => theme.fg("accent", text),
				position: (text) => theme.fg("muted", text),
				empty: (text) => theme.fg("muted", text),
			},
			row: (item, { selected, width }) => [
				...item.above.map((line) => this.renderLine(line, width)),
				...this.renderRow(item.row, width, Math.min(nameCap(width), longestName), selected),
			],
		});
		const initial = items.findIndex((item) => item.row.id === options.initialId);
		this.list.setSelectedIndex(Math.max(0, initial));
		this.list.onSelect = (item) => options.onSelect(item.row.id);
		this.list.onCancel = () => options.onCancel();
		this.list.onSelectionChange = (item) => options.onHighlight?.(item.row.id);
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width <= 0) return [];
		this.width = width;
		const { title, facts = [], notes = [], alerts = [] } = this.options;
		const border = ruleLine(width);
		const wrap = (text: string) => wrapIndented(text, width, 1);
		const factLines = facts.flatMap((fact) => wrap(` ${theme.fg("muted", fact.label)}  ${fact.value}`));
		const tail = [
			...alerts.flatMap((alert) => wrap(` ${theme.fg("error", alert)}`)),
			...notes.flatMap((note) => wrap(` ${theme.fg("muted", note)}`)),
			...(this.options.legend?.length ? wrap(` ${theme.fg("muted", legend(this.options.legend))}`) : []),
		];
		const viewport = this.options.viewportRows?.() ?? process.stdout.rows ?? 24;
		// Title, rules, footer and one heading per section; the rows keep at least three lines.
		const fixed = 6 + tail.length + this.trailing.length + this.options.sections.length;
		const rowLines = Math.min(this.selectable.length, 3);
		const factRoom = Math.max(2, viewport - fixed - rowLines - 1);
		this.factsOverflow = factLines.length > factRoom;
		this.factPage = Math.max(1, factRoom - 1);
		this.factScroll = this.factsOverflow ? Math.max(0, Math.min(this.factScroll, factLines.length - factRoom + 1)) : 0;
		const shownFacts = this.factsOverflow
			? [
					...factLines.slice(this.factScroll, this.factScroll + factRoom - 1),
					this.factsFoot(factLines.length, factRoom - 1, width),
				]
			: factLines;
		const head = [
			border,
			truncateToWidth(` ${theme.fg("accent", theme.bold(title))}`, width, "…"),
			"",
			...shownFacts,
			...(facts.length ? [""] : []),
		];
		const room = viewport - fixed - head.length + 3;
		this.list.setMaxRows(Math.max(3, Math.min(MAX_ROWS, room)));
		this.listTop = head.length;
		const body = this.selectable.length > 0 ? this.list.render(width) : [];
		return [
			...head,
			...body,
			...this.trailing.map((line) => this.renderLine(line, width)),
			...tail,
			this.footer(width),
			border,
		];
	}

	/** `a–b/total facts · pgup/pgdn scroll` under a fact window. */
	private factsFoot(total: number, shown: number, width: number): string {
		const last = Math.min(total, this.factScroll + shown);
		const keys = `${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")}`;
		return truncateToWidth(
			` ${theme.fg("muted", `${positionLabel(this.factScroll + 1, last, total)} facts`)}${theme.fg("dim", " · ")}${hintLine([[keys, "scroll"]])}`,
			width,
			"…",
		);
	}

	private footer(width: number): string {
		const { hints, facts, nested = false, enter } = this.options;
		if (hints) return renderHintLine(hints, width);
		const row = this.list.getSelectedItem()?.row;
		return renderHintLine(
			pageHints(facts?.length ? "detail" : "list", {
				nested,
				rowKeys: row?.keys,
				enter: this.selectable.length === 0 ? false : enter,
			}),
			width,
		);
	}

	private renderLine(line: Line, width: number): string {
		if ("heading" in line) return truncateToWidth(` ${theme.fg("muted", theme.bold(line.heading))}`, width, "…");
		return truncateToWidth(`   ${theme.fg("muted", line.note)}`, width, "…");
	}

	/** The row, and on a narrow terminal or a long row the selected row's detail on the lines under it. */
	private renderRow(row: PageRow, width: number, nameWidth: number, selected: boolean): string[] {
		const narrow = width < 72;
		const long = !!row.detail && visibleWidth(`   ${row.name}  ${row.detail}  ${row.badge ?? ""}`) > width;
		const wrapped = selected && !!row.detail && (narrow || long);
		const line = this.rowLine(narrow || wrapped ? { ...row, detail: undefined } : row, width, nameWidth, selected);
		if (!wrapped || !row.detail) return [line];
		return [line, ...wrapIndented(`   ${theme.fg("muted", row.detail)}`, width, 3)];
	}

	private rowLine(row: PageRow, width: number, nameWidth: number, selected: boolean): string {
		const name = pad(row.name, nameWidth);
		const left = `${cursorMark(selected)}${selected ? selectedText(name) : theme.fg("text", name)}${row.detail ? `  ${theme.fg("muted", row.detail)}` : ""}`;
		if (!row.badge) return truncateToWidth(` ${left}`, width, "…");
		// Keep the selection marker and a name column while reserving room for the status.
		const badge = truncateToWidth(theme.fg(row.tone ?? "muted", row.badge), Math.max(0, width - 5), "…");
		const badgeWidth = visibleWidth(badge);
		if (badgeWidth === 0) return truncateToWidth(` ${left}`, width, "…");
		const room = width - badgeWidth - 2;
		const head = pad(truncateToWidth(` ${left}`, room, "…"), room);
		return `${head}  ${badge}`;
	}

	/** A row that declares keys takes only those; a page where no row declares any uses the page-wide list. */
	private rowAccepts(row: PageRow, key: string): boolean {
		if (this.selectable.some((candidate) => candidate.keys)) return row.keys !== undefined && key in row.keys;
		return this.options.keys?.includes(key) ?? false;
	}

	handleInput(data: string): void {
		if (this.options.onInput?.(data)) return;
		const row = this.list.getSelectedItem()?.row;
		const kb = getKeybindings();
		const page = kb.matches(data, "tui.select.pageUp") ? -1 : kb.matches(data, "tui.select.pageDown") ? 1 : 0;
		const rowsFit = this.list.visibleRange().end - this.list.visibleRange().start >= this.list.getItems().length;
		if (page && this.factsOverflow && rowsFit) this.factScroll = Math.max(0, this.factScroll + page * this.factPage);
		else if (row && this.rowAccepts(row, data)) this.options.onKey?.(data, row.id);
		else this.list.handleInput(data);
	}

	/** The wheel moves the cursor and a click selects a row; neither acts on it. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.selectable.length === 0) return undefined;
		const y = event.y - this.listTop;
		if (event.type !== "wheel" && y < 0) return undefined;
		return this.list.handleMouse({ ...event, y, width: this.width });
	}
}
