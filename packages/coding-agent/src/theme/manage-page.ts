/**
 * One page of the list → detail → action pattern (commands design §3): a title, optional fact rows, sections of
 * selectable rows with a status badge, and one key-hint line. The list page and the detail page are the same component;
 * a detail page passes `facts` and a single "Actions" section.
 */

import { type Component, getKeybindings, GLYPH, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import { theme } from "./theme.ts";
import { type RankedHint, renderHintLine } from "./theme-tui-helpers.ts";

export interface PageRow {
	id: string;
	name: string;
	/** Muted text after the name. */
	detail?: string;
	/** Short state word at the right edge (`enabled`, `on`, `off`). */
	badge?: string;
	tone?: "success" | "muted" | "warning" | "error";
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
	hints: readonly RankedHint[];
	/** Row to select first. */
	initialId?: string;
	/** Single keys (`e`) reported with the selected row's id. */
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
		const { title, notes = [], alerts = [], facts = [], hints } = this.options;
		const border = theme.fg("border", "─".repeat(Math.max(1, width)));
		const out = [border, truncateToWidth(` ${theme.fg("accent", theme.bold(title))}`, width, "…")];
		if (facts.length > 0) {
			const labelWidth = Math.max(...facts.map((fact) => visibleWidth(fact.label)));
			out.push("");
			for (const fact of facts) {
				out.push(truncateToWidth(` ${theme.fg("muted", pad(fact.label, labelWidth))}  ${fact.value}`, width, "…"));
			}
		}
		out.push("");
		const lines = this.lines();
		const selectedRow = this.selectable[this.selected];
		const at = Math.max(
			0,
			lines.findIndex((line) => line.row === selectedRow),
		);
		const start = Math.max(0, Math.min(at - Math.floor(MAX_LINES / 2), lines.length - MAX_LINES));
		const nameWidth = Math.min(MAX_NAME_WIDTH, Math.max(0, ...this.selectable.map((row) => visibleWidth(row.name))));
		for (const line of lines.slice(start, start + MAX_LINES)) {
			out.push(this.renderLine(line, width, nameWidth, selectedRow));
		}
		if (lines.length > MAX_LINES) {
			out.push(theme.fg("muted", `  (${this.selected + 1}/${this.selectable.length})`));
		}
		for (const alert of alerts) out.push(truncateToWidth(` ${theme.fg("error", alert)}`, width, "…"));
		for (const note of notes) out.push(truncateToWidth(` ${theme.fg("muted", note)}`, width, "…"));
		out.push(renderHintLine(hints, width), border);
		return out;
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
		const badge = theme.fg(row.tone ?? "muted", row.badge);
		const room = width - visibleWidth(row.badge) - 3;
		const head = pad(truncateToWidth(` ${left}`, Math.max(1, room), "…"), Math.max(1, room));
		return `${head}  ${badge}`;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const row = this.selectable[this.selected];
		if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
			const step = kb.matches(data, "tui.select.up") ? -1 : 1;
			this.selected = Math.max(0, Math.min(this.selectable.length - 1, this.selected + step));
			const moved = this.selectable[this.selected];
			if (moved) this.options.onHighlight?.(moved.id);
		} else if (kb.matches(data, "tui.select.confirm")) {
			if (row) this.options.onSelect(row.id);
		} else if (kb.matches(data, "tui.select.cancel")) this.options.onCancel();
		else if (row && this.options.keys?.includes(data)) this.options.onKey?.(data, row.id);
	}
}
