import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings } from "../keybindings.ts";
import { GLYPH } from "../tokens/design.ts";
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { CURSOR_MARKER } from "../tui/cursor.ts";
import { truncateToWidth } from "../utils/truncate.ts";
import { visibleWidth } from "../utils/width.ts";

/** The glyph that starts the search line. */
export const SEARCH_GLYPH = "⌕";

export interface ListViewTheme {
	/** The `› ` mark on the selected row. */
	cursor: (text: string) => string;
	/** The `a–b/total` foot and the hint beside it. */
	position: (text: string) => string;
	/** The empty-state row. */
	empty: (text: string) => string;
	/** The search line; defaults to the plain text. */
	search?: (text: string) => string;
}

export interface ListViewOptions<T> {
	items: readonly T[];
	/** The item's lines (one or two) at `width`, without the cursor mark when `mark` is on. */
	row: (item: T, state: { selected: boolean; width: number }) => string | string[];
	/** Visible item rows: the host passes what the screen leaves (`terminal.rows - chrome`), never a constant. */
	maxRows: number;
	theme: ListViewTheme;
	/** Draw `› ` before the selected row and two spaces before the rest (default). Off: `row` draws its own mark. */
	mark?: boolean;
	/** A search line above the list; printable keys type into it. `text` is what the default fuzzy filter matches. */
	search?: { text: (item: T) => string; filter?: (items: readonly T[], query: string) => T[]; placeholder?: string };
	/** The empty-state row and its recovery key; with a search query, the recovery defaults to `esc clears`. */
	empty?: { message: string; recover?: readonly [key: string, verb: string] };
	/** One hint line under the list; cut, never wrapped. `emptyHint` replaces it while no item shows. */
	hint?: string;
	emptyHint?: string;
	/** Up/down at an end wraps to the other end (autocomplete); default clamp. Page keys and the wheel always clamp. */
	wrap?: boolean;
	/** Window placement: `context` (default) scrolls only to keep one row of context; `center` keeps the cursor mid-list. */
	window?: "context" | "center";
	/**
	 * `true` (default, pickers): a click selects, a click on the selected row confirms. `false` (pages): clicks only
	 * select. `"first"` (autocomplete, short menus): the first click selects and confirms.
	 */
	clickConfirms?: boolean | "first";
}

/** `a–b/total`: the 1-based items in view and how many there are. */
export function positionLabel(start: number, end: number, total: number): string {
	return `${start + 1}–${end}/${total}`;
}

/**
 * One list for pickers, pages and autocomplete: a `› ` cursor, page keys by the visible rows, wheel and click, an
 * item-counting `a–b/total` foot, an optional `⌕` search line, and one empty-state row naming its recovery key.
 */
export class ListView<T> implements Component, Focusable {
	private all: readonly T[];
	private shown: readonly T[];
	private selected = 0;
	private top = 0;
	private query = "";
	private press: { index: number; wasSelected: boolean } | undefined;
	/** Lines each item in view took in the last render, from its first visible index. */
	private drawn = { start: 0, heights: [] as number[] };
	private readonly options: ListViewOptions<T>;
	focused = false;

	onSelect?: (item: T) => void;
	onCancel?: () => void;
	onSelectionChange?: (item: T) => void;

	constructor(options: ListViewOptions<T>) {
		this.options = { ...options };
		this.all = options.items;
		this.shown = options.items;
	}

	/** Replaces the items; the cursor stays on its index, clamped. */
	setItems(items: readonly T[]): void {
		this.all = items;
		this.applyFilter();
	}

	setMaxRows(rows: number): void {
		this.options.maxRows = rows;
	}

	setEmpty(empty: ListViewOptions<T>["empty"]): void {
		this.options.empty = empty;
	}

	setHint(hint: string | undefined, emptyHint?: string): void {
		this.options.hint = hint;
		this.options.emptyHint = emptyHint;
	}

	getQuery(): string {
		return this.query;
	}

	setQuery(query: string): void {
		this.query = query;
		this.selected = 0;
		this.top = 0;
		this.applyFilter();
	}

	/** The items the search leaves, in order. */
	getItems(): readonly T[] {
		return this.shown;
	}

	getSelectedIndex(): number {
		return this.selected;
	}

	getSelectedItem(): T | undefined {
		return this.shown[this.selected];
	}

	setSelectedIndex(index: number): void {
		this.selected = Math.max(0, Math.min(index, this.shown.length - 1));
	}

	/** The item rows in view, `[start, end)`, as the next render draws them. */
	visibleRange(): { start: number; end: number } {
		const rows = this.rows();
		const count = this.shown.length;
		if (this.options.window === "center") {
			this.top = Math.max(0, Math.min(this.selected - Math.floor(rows / 2), count - rows));
		} else {
			const context = rows > 2 ? 1 : 0;
			if (this.selected - context < this.top) this.top = this.selected - context;
			if (this.selected + context >= this.top + rows) this.top = this.selected + context - rows + 1;
			this.top = Math.max(0, Math.min(this.top, count - rows));
		}
		return { start: this.top, end: Math.min(this.top + rows, count) };
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		if (this.options.search) lines.push(this.searchLine(width));
		if (this.shown.length === 0) {
			lines.push(this.emptyLine(width));
			const hint = this.options.emptyHint;
			if (hint) lines.push(this.options.theme.position(truncateToWidth(` ${hint}`, width, "…")));
			return lines;
		}
		const { start, end } = this.visibleRange();
		const mark = this.options.mark !== false;
		// Marked rows get what the 2-column mark leaves; `markRow` cuts a row that is wider still.
		const rowWidth = mark ? Math.max(1, width - 2) : width;
		// Rendering runs on every keystroke in autocomplete: reuse the heights array and build no per-row arrays.
		const heights = this.drawn.heights;
		heights.length = 0;
		this.drawn.start = start;
		for (let index = start; index < end; index++) {
			const isSelected = index === this.selected;
			const drawn = this.options.row(this.shown[index], { selected: isSelected, width: rowWidth });
			if (typeof drawn === "string") {
				heights.push(1);
				lines.push(mark ? this.markRow(drawn, isSelected, width) : drawn);
				continue;
			}
			heights.push(drawn.length);
			for (let line = 0; line < drawn.length; line++) {
				lines.push(mark ? this.markRow(drawn[line], isSelected && line === 0, width) : drawn[line]);
			}
		}
		const foot = this.footLine(start, end, width);
		if (foot !== undefined) lines.push(foot);
		return lines;
	}

	/**
	 * The mark and the row, cut to `width`. A row that fits is joined as it is: `visibleWidth` is cached and takes styled
	 * ASCII without segmenting, so the common case allocates nothing but the joined line.
	 */
	private markRow(row: string, cursor: boolean, width: number): string {
		if (width < 3) {
			// No room for the row beside the mark: draw only as much of the mark as fits.
			const mark = cursor ? `${GLYPH.cursor} `.slice(0, width) : "  ".slice(0, width);
			return cursor ? this.options.theme.cursor(mark) : mark;
		}
		const room = width - 2;
		const fitted = visibleWidth(row) <= room ? row : truncateToWidth(row, room, "…");
		return cursor ? this.options.theme.cursor(`${GLYPH.cursor} `) + fitted : `  ${fitted}`;
	}

	/** `a–b/total` while the list scrolls, then the hint; none when neither shows. */
	private footLine(start: number, end: number, width: number): string | undefined {
		const count = this.shown.length;
		const position = start > 0 || end < count ? positionLabel(start, end, count) : "";
		const hint = this.options.hint ?? "";
		if (!position && !hint) return undefined;
		const text = position && hint ? `  ${position}  ${hint}` : `  ${position || hint}`;
		// The position label is one column per character, so only the hint needs measuring.
		const textWidth = 2 + position.length + (position && hint ? 2 : 0) + (hint ? visibleWidth(hint) : 0);
		return this.options.theme.position(textWidth <= width ? text : truncateToWidth(text, width, "…"));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.options.search && this.query) this.setQuery("");
			else this.onCancel?.();
			return;
		}
		if (kb.matches(data, "tui.select.up")) this.move(-1, this.options.wrap === true);
		else if (kb.matches(data, "tui.select.down")) this.move(1, this.options.wrap === true);
		else if (kb.matches(data, "tui.select.pageUp")) this.move(-this.rows(), false);
		else if (kb.matches(data, "tui.select.pageDown")) this.move(this.rows(), false);
		else if (kb.matches(data, "tui.select.home")) this.move(-this.shown.length, false);
		else if (kb.matches(data, "tui.select.end")) this.move(this.shown.length, false);
		else if (kb.matches(data, "tui.select.confirm")) this.confirm();
		else if (this.options.search) this.typeInSearch(data);
	}

	/** Moves the cursor by `delta` items, clamped at the ends or wrapping around them. */
	move(delta: number, wrap = false): void {
		const count = this.shown.length;
		if (count === 0) return;
		const previous = this.selected;
		const next = this.selected + delta;
		this.selected = wrap ? (next + count) % count : Math.max(0, Math.min(count - 1, next));
		if (this.selected !== previous) this.notifySelectionChange();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.shown.length === 0) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			const previous = this.selected;
			this.move(event.wheelDelta < 0 ? -1 : 1);
			return { handled: true, render: this.selected !== previous };
		}
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const index = this.indexAt(event.y);
		if (index === undefined) return undefined;
		if (event.type === "press") {
			this.press = { index, wasSelected: index === this.selected };
			if (index !== this.selected) {
				this.selected = index;
				this.notifySelectionChange();
			}
			return { handled: true, focus: true };
		}
		const press = this.press ?? { index, wasSelected: index === this.selected };
		this.press = undefined;
		if (press.index !== this.selected) {
			this.selected = press.index;
			this.notifySelectionChange();
		}
		const confirms = this.options.clickConfirms ?? true;
		if (confirms === "first" || (confirms && press.wasSelected)) this.confirm();
		return { handled: true };
	}

	private confirm(): void {
		const item = this.shown[this.selected];
		if (item !== undefined) this.onSelect?.(item);
	}

	/** The item under local row `y`, or none (the search line, the foot, past the end). */
	private indexAt(y: number): number | undefined {
		const { start, end } = this.visibleRange();
		let row = y - (this.options.search ? 1 : 0);
		for (let index = start; index < end && row >= 0; index++) {
			const height = (start === this.drawn.start ? this.drawn.heights[index - start] : undefined) ?? 1;
			if (row < height) return index;
			row -= height;
		}
		return undefined;
	}

	private rows(): number {
		return Math.max(1, Math.floor(this.options.maxRows));
	}

	private typeInSearch(data: string): void {
		if (data === "\x7f" || data === "\b") return this.setQuery(Array.from(this.query).slice(0, -1).join(""));
		// Printable text only: control and escape sequences are keys this list does not take.
		if (/^[^\x00-\x1f\x7f]+$/u.test(data) && !data.startsWith("\x1b")) this.setQuery(this.query + data);
	}

	private applyFilter(): void {
		const search = this.options.search;
		if (!search || !this.query) this.shown = this.all;
		else if (search.filter) this.shown = search.filter(this.all, this.query);
		else this.shown = fuzzyFilter([...this.all], this.query, search.text);
		this.setSelectedIndex(this.selected);
	}

	private searchLine(width: number): string {
		const style = this.options.theme.search ?? ((text: string) => text);
		const text = this.query || this.options.search?.placeholder || "";
		const cursor = this.focused ? CURSOR_MARKER : "";
		const line = this.query ? `${SEARCH_GLYPH} ${text}${cursor}` : `${SEARCH_GLYPH} ${cursor}${text}`;
		return style(truncateToWidth(` ${line}`, width, "…"));
	}

	private emptyLine(width: number): string {
		const empty = this.options.empty ?? { message: "No items" };
		const recover = empty.recover ?? (this.query ? (["esc", "clears"] as const) : undefined);
		const text = recover ? `${empty.message} · ${recover[0]} ${recover[1]}` : empty.message;
		return this.options.theme.empty(truncateToWidth(`  ${text}`, width, "…"));
	}

	private notifySelectionChange(): void {
		const item = this.shown[this.selected];
		if (item !== undefined) this.onSelectionChange?.(item);
	}
}
