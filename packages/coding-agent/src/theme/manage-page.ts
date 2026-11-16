/**
 * One page of the list → detail → action pattern (commands design §3): a title, optional fact rows, sections of
 * selectable rows with a status badge, and one key-hint line. The list page and the detail page are the same component;
 * a detail page passes `facts` and a single "Actions" section.
 */

import {
	type Component,
	getKeybindings,
	GLYPH,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@octocodeai/octocode-tui";
import { ruleLine } from "./dynamic-border.ts";
import { theme } from "./theme.ts";
import { type BadgeState, type EnterVerb, legend, pageHints, positionLabel } from "./page-kit.ts";
import { hintLine, keyText, type RankedHint, renderHintLine } from "./theme-tui-helpers.ts";

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
	/** @deprecated Every page is responsive; the flag is ignored. Remove it from callers. */
	responsive?: boolean;
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
	onCancel(): void;
}

type Line = { text?: string; row?: PageRow; heading?: string; note?: string };

const MAX_LINES = 14;
const MAX_NAME_WIDTH = 24;

function pad(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

export class ManagePageComponent implements Component {
	private readonly selectable: PageRow[];
	private selected = 0;
	private readonly options: ManagePageOptions;
	private scroll = 0;
	private bodyRows = MAX_LINES;
	private manualScroll = false;
	private selectionVisible = true;

	constructor(options: ManagePageOptions) {
		this.options = options;
		this.selectable = options.sections.flatMap((section) => [...section.rows]);
		const initial = this.selectable.findIndex((row) => row.id === options.initialId);
		this.selected = Math.max(0, initial);
	}

	invalidate(): void {}

	private lines(): Line[] {
		const lines: Line[] = [];
		for (const section of this.options.sections) {
			lines.push({ heading: section.heading });
			for (const row of section.rows) lines.push({ row });
			if (section.rows.length === 0 && section.empty) lines.push({ note: section.empty });
		}
		return lines;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		return this.renderBody(width);
	}

	private footer(width: number): string {
		const { hints, facts, nested = false, enter } = this.options;
		if (hints) return renderHintLine(hints, width);
		const row = this.selectable[this.selected];
		return renderHintLine(
			pageHints(facts?.length ? "detail" : "list", {
				nested,
				rowKeys: row?.keys,
				enter: this.selectable.length === 0 ? false : enter,
			}),
			width,
		);
	}

	private renderBody(width: number): string[] {
		const { title, facts = [], notes = [], alerts = [] } = this.options;
		const border = ruleLine(width);
		const selected = this.selectable[this.selected];
		const body: { text: string; id?: string }[] = [];
		const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(1, width));
		for (const fact of facts)
			for (const text of wrap(` ${theme.fg("muted", fact.label)}  ${fact.value}`)) body.push({ text });
		if (facts.length) body.push({ text: "" });
		const nameWidth = Math.min(MAX_NAME_WIDTH, Math.max(1, ...this.selectable.map((row) => visibleWidth(row.name))));
		for (const line of this.lines()) {
			const row = line.row;
			const narrow = width < 72;
			const shown = row && narrow ? { ...row, detail: undefined } : row;
			body.push({
				text: this.renderLine(shown ? { row: shown } : line, width, nameWidth, row === selected ? shown : undefined),
				id: row?.id,
			});
			if (
				row &&
				row === selected &&
				row.detail &&
				(narrow || visibleWidth(`   ${row.name}  ${row.detail}  ${row.badge ?? ""}`) > width)
			) {
				for (const text of wrap(`   ${theme.fg("muted", row.detail)}`)) body.push({ text });
			}
		}
		const tail = [
			...alerts.flatMap((alert) => wrap(` ${theme.fg("error", alert)}`)),
			...notes.flatMap((note) => wrap(` ${theme.fg("muted", note)}`)),
			...(this.options.legend?.length ? wrap(` ${theme.fg("muted", legend(this.options.legend))}`) : []),
		];
		this.bodyRows = Math.max(
			3,
			Math.min(MAX_LINES, (this.options.viewportRows?.() ?? process.stdout.rows ?? 24) - tail.length - 7),
		);
		const at = Math.max(
			0,
			body.findIndex((line) => line.id === selected?.id),
		);
		if (!this.manualScroll) {
			if (at < this.scroll) this.scroll = Math.max(0, at - 1);
			else if (at >= this.scroll + this.bodyRows) this.scroll = at - this.bodyRows + 1;
		}
		this.scroll = Math.max(0, Math.min(this.scroll, body.length - this.bodyRows));
		this.selectionVisible = body
			.slice(this.scroll, this.scroll + this.bodyRows)
			.some((line) => line.id === selected?.id);
		const scrolling = body.length > this.bodyRows;
		return [
			border,
			truncateToWidth(` ${theme.fg("accent", theme.bold(title))}`, width, "…"),
			"",
			...body.slice(this.scroll, this.scroll + this.bodyRows).map((line) => line.text),
			...(scrolling
				? [
						truncateToWidth(
							` ${theme.fg("muted", positionLabel(this.scroll + 1, Math.min(body.length, this.scroll + this.bodyRows), body.length))}${theme.fg("dim", " · ")}${hintLine([[`${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")}`, "scroll"]])}${this.selectionVisible ? "" : `${theme.fg("dim", " · ")}${hintLine([[keyText("tui.select.confirm"), "show selection"]])}`}`,
							width,
							"…",
						),
					]
				: []),
			...tail,
			this.footer(width),
			border,
		];
	}

	private renderLine(line: Line, width: number, nameWidth: number, selectedRow: PageRow | undefined): string {
		if (line.heading !== undefined)
			return truncateToWidth(` ${theme.fg("muted", theme.bold(line.heading))}`, width, "…");
		if (line.note !== undefined) return truncateToWidth(`   ${theme.fg("muted", line.note)}`, width, "…");
		if (!line.row) return "";
		const row = line.row;
		const selected = row === selectedRow;
		const name = pad(row.name, nameWidth);
		const left = `${selected ? theme.fg("accent", `${GLYPH.cursor} `) : "  "}${selected ? theme.fg("accent", name) : theme.fg("text", name)}${row.detail ? `  ${theme.fg("muted", row.detail)}` : ""}`;
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
		const kb = getKeybindings();
		const row = this.selectable[this.selected];
		if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.select.pageDown")) {
			this.scroll += kb.matches(data, "tui.select.pageUp") ? -this.bodyRows : this.bodyRows;
			this.manualScroll = true;
		} else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			this.manualScroll = false;
			const step = kb.matches(data, "tui.select.up") ? -1 : 1;
			this.selected = Math.max(0, Math.min(this.selectable.length - 1, this.selected + step));
			const moved = this.selectable[this.selected];
			if (moved) this.options.onHighlight?.(moved.id);
		} else if (kb.matches(data, "tui.select.confirm")) {
			if (!this.selectionVisible) {
				// The selection is scrolled off: bring it back instead of acting on a row the user cannot see.
				this.manualScroll = false;
				return;
			}
			if (row) this.options.onSelect(row.id);
		} else if (kb.matches(data, "tui.select.cancel")) this.options.onCancel();
		else if (row && this.selectionVisible && this.rowAccepts(row, data)) this.options.onKey?.(data, row.id);
	}
}
