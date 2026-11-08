import { getKeybindings } from "../keybindings.ts";
import { GLYPH } from "../tokens/design.ts";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { stripTerminalSequences } from "../utils/ansi-codes.ts";
import { stripControlCharacters } from "../utils/chars.ts";
import { visibleWidth } from "../utils/width.ts";
import { truncateToWidth } from "../utils/truncate.ts";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

// Bidi embeddings, overrides, isolates and marks: they reorder the text drawn after them.
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Labels and descriptions come from untrusted sources (skill and prompt frontmatter, file names): draw them
 * on one line without terminal sequences, control characters or bidi controls.
 */
const toDisplayLine = (text: string): string =>
	stripControlCharacters(stripTerminalSequences(text.replace(/[\r\n\u2028\u2029]+/g, " "))).replace(BIDI_CONTROLS, "");
const normalizeToSingleLine = (text: string): string => toDisplayLine(text).trim();
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

export interface SelectItem {
	value: string;
	label: string;
	description?: string;
	/** Indexes into `label` of characters to highlight (file and directory rows). */
	matches?: number[];
	/** `file` and `directory` rows draw the label with highlights and the description as a dim parent path. */
	kind?: "file" | "directory" | "command";
}

export interface SelectListTheme {
	selectedPrefix: (text: string) => string;
	selectedText: (text: string) => string;
	description: (text: string) => string;
	scrollInfo: (text: string) => string;
	noMatch: (text: string) => string;
	/** Matched label characters; defaults to the selected-text colour in bold. */
	matchHighlight?: (text: string) => string;
	/** Directory names; defaults to the plain colour. */
	directory?: (text: string) => string;
	/** The key hint; defaults to `scrollInfo`. */
	hint?: (text: string) => string;
}

export interface SelectListOptions {
	/** Row shown when no item matches; defaults to "No matching commands". */
	emptyText?: string;
	/** Dim key hint appended to the scroll-info row when the width allows. */
	hint?: string;
}

const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const bold = (text: string): string => `${BOLD_ON}${text}${BOLD_OFF}`;
const HINT_SEPARATOR = "  ";

export interface SelectListTruncatePrimaryContext {
	text: string;
	maxWidth: number;
	columnWidth: number;
	item: SelectItem;
	isSelected: boolean;
}

export interface SelectListLayoutOptions {
	minPrimaryColumnWidth?: number;
	maxPrimaryColumnWidth?: number;
	truncatePrimary?: (context: SelectListTruncatePrimaryContext) => string;
}

export class SelectList implements Component {
	private items: SelectItem[] = [];
	private filteredItems: SelectItem[] = [];
	private selectedIndex: number = 0;
	private mousePressedIndex: number | undefined;
	private maxVisible: number = 5;
	private theme: SelectListTheme;
	private layout: SelectListLayoutOptions;
	private options: SelectListOptions;

	public onSelect?: (item: SelectItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: SelectItem) => void;

	constructor(
		items: SelectItem[],
		maxVisible: number,
		theme: SelectListTheme,
		layout: SelectListLayoutOptions = {},
		options: SelectListOptions = {},
	) {
		this.options = options;
		this.items = items;
		this.filteredItems = items;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.layout = layout;
	}

	/** Replaces the empty-state row, e.g. with an indexing progress line. */
	setEmptyText(text: string | undefined): void {
		this.options = { ...this.options, emptyText: text };
	}

	setFilter(filter: string): void {
		this.filteredItems = this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase()));
		// Reset selection when filter changes
		this.selectedIndex = 0;
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(index, this.filteredItems.length - 1));
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		const lines: string[] = [];

		// If no items match filter, show message
		if (this.filteredItems.length === 0) {
			lines.push(this.theme.noMatch(`  ${toDisplayLine(this.options.emptyText ?? "No matching commands")}`));
			return lines;
		}

		const primaryColumnWidth = this.getPrimaryColumnWidth();

		// Calculate visible range with scrolling
		const { startIndex, endIndex } = this.getVisibleRange();

		// Render visible items
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredItems[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const descriptionSingleLine = item.description ? normalizeToSingleLine(item.description) : undefined;
			lines.push(this.renderItem(item, isSelected, width, descriptionSingleLine, primaryColumnWidth));
		}

		// Add scroll indicators if needed
		const scrolls = startIndex > 0 || endIndex < this.filteredItems.length;
		const scrollText = scrolls ? `  (${this.selectedIndex + 1}/${this.filteredItems.length})` : "";
		const hint = this.options.hint;
		const hintText = hint ? (scrolls ? HINT_SEPARATOR : "  ") + hint : "";
		if (hint && visibleWidth(scrollText + hintText) <= width - 2) {
			lines.push((this.theme.hint ?? this.theme.scrollInfo)(scrollText + hintText));
		} else if (scrolls) {
			// Truncate if too long for terminal
			lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
		}

		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.filteredItems.length === 0) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			const delta = event.wheelDelta < 0 ? -1 : 1;
			const previousIndex = this.selectedIndex;
			this.selectedIndex = Math.max(0, Math.min(this.filteredItems.length - 1, this.selectedIndex + delta));
			if (this.selectedIndex !== previousIndex) this.notifySelectionChange();
			return { handled: true, render: this.selectedIndex !== previousIndex };
		}
		// Hover must not change selection: the visible range is centered on it.
		if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
		const { startIndex, endIndex } = this.getVisibleRange();
		const itemIndex = startIndex + event.y;
		if (itemIndex < startIndex || itemIndex >= endIndex) return undefined;

		if (event.type === "press") {
			this.mousePressedIndex = itemIndex;
			if (this.selectedIndex !== itemIndex) {
				this.selectedIndex = itemIndex;
				this.notifySelectionChange();
			}
			return { handled: true, focus: true };
		}
		if (event.type === "click") {
			const clickedIndex = this.mousePressedIndex ?? itemIndex;
			this.mousePressedIndex = undefined;
			const changed = this.selectedIndex !== clickedIndex;
			this.selectedIndex = clickedIndex;
			if (changed) this.notifySelectionChange();
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem) this.onSelect?.(selectedItem);
			return { handled: true };
		}
		return undefined;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (this.filteredItems.length === 0 && !kb.matches(keyData, "tui.select.cancel")) return;
		if (kb.matches(keyData, "tui.select.up")) this.moveSelection(-1);
		else if (kb.matches(keyData, "tui.select.down")) this.moveSelection(1);
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedItem = this.filteredItems[this.selectedIndex];
			if (selectedItem && this.onSelect) {
				this.onSelect(selectedItem);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
	}

	/** Moves the selection one row, wrapping at both ends. */
	moveSelection(delta: -1 | 1): void {
		const count = this.filteredItems.length;
		if (count === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
		this.notifySelectionChange();
	}

	private getVisibleRange(): { startIndex: number; endIndex: number } {
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		return {
			startIndex,
			endIndex: Math.min(startIndex + this.maxVisible, this.filteredItems.length),
		};
	}

	private renderItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		descriptionSingleLine: string | undefined,
		primaryColumnWidth: number,
	): string {
		const prefix = isSelected ? `${GLYPH.cursor} ` : "  ";
		const prefixWidth = visibleWidth(prefix);
		if (item.kind === "file" || item.kind === "directory") {
			return this.renderPathItem(item, isSelected, width, prefix, descriptionSingleLine);
		}

		if (descriptionSingleLine && width > 40) {
			const effectivePrimaryColumnWidth = Math.max(1, Math.min(primaryColumnWidth, width - prefixWidth - 4));
			const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
			const truncatedValue = this.truncatePrimary(item, isSelected, maxPrimaryWidth, effectivePrimaryColumnWidth);
			const truncatedValueWidth = visibleWidth(truncatedValue);
			const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - truncatedValueWidth));
			const descriptionStart = prefixWidth + truncatedValueWidth + spacing.length;
			const remainingWidth = width - descriptionStart - 2; // -2 for safety

			if (remainingWidth > MIN_DESCRIPTION_WIDTH) {
				const truncatedDesc = truncateToWidth(descriptionSingleLine, remainingWidth, "…");
				if (isSelected) {
					return this.theme.selectedText(`${prefix}${truncatedValue}${spacing}${truncatedDesc}`);
				}

				const descText = this.theme.description(spacing + truncatedDesc);
				return prefix + truncatedValue + descText;
			}
		}

		const maxWidth = width - prefixWidth - 2;
		const truncatedValue = this.truncatePrimary(item, isSelected, maxWidth, maxWidth);
		if (isSelected) {
			return this.theme.selectedText(`${prefix}${truncatedValue}`);
		}

		return prefix + truncatedValue;
	}

	private renderPathItem(
		item: SelectItem,
		isSelected: boolean,
		width: number,
		prefix: string,
		description: string | undefined,
	): string {
		const label = this.getDisplayValue(item);
		const maxLabelWidth = Math.max(1, width - visibleWidth(prefix) - 2);
		const shownLabel = truncateToWidth(label, maxLabelWidth, "");
		const matched = new Set(label === (item.label || item.value) ? item.matches : []);
		const plain = item.kind === "directory" && !isSelected ? (this.theme.directory ?? identity) : identity;
		const highlight = isSelected ? bold : (this.theme.matchHighlight ?? ((t) => bold(this.theme.selectedText(t))));
		let name = "";
		let run = "";
		let runMatched = false;
		let offset = 0;
		const flush = () => {
			if (run) name += runMatched ? highlight(run) : plain(run);
			run = "";
		};
		for (const char of shownLabel) {
			const isMatch = matched.has(offset);
			if (isMatch !== runMatched) flush();
			runMatched = isMatch;
			run += char;
			offset += char.length;
		}
		flush();

		const parent = description ? parentDirectory(description) : "";
		const room = width - visibleWidth(prefix) - visibleWidth(shownLabel) - 4;
		const parentText = parent && room > 3 ? `  ${truncateLeft(parent, room)}` : "";
		if (isSelected) return this.theme.selectedText(`${prefix}${name}${parentText}`);
		return prefix + name + (parentText ? this.theme.description(parentText) : "");
	}

	private getPrimaryColumnWidth(): number {
		const { min, max } = this.getPrimaryColumnBounds();
		const widestPrimary = this.filteredItems.reduce((widest, item) => {
			return Math.max(widest, visibleWidth(this.getDisplayValue(item)) + PRIMARY_COLUMN_GAP);
		}, 0);

		return clamp(widestPrimary, min, max);
	}

	private getPrimaryColumnBounds(): { min: number; max: number } {
		const rawMin =
			this.layout.minPrimaryColumnWidth ?? this.layout.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;
		const rawMax =
			this.layout.maxPrimaryColumnWidth ?? this.layout.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH;

		return {
			min: Math.max(1, Math.min(rawMin, rawMax)),
			max: Math.max(1, Math.max(rawMin, rawMax)),
		};
	}

	private truncatePrimary(item: SelectItem, isSelected: boolean, maxWidth: number, columnWidth: number): string {
		const displayValue = this.getDisplayValue(item);
		const truncatedValue = this.layout.truncatePrimary
			? this.layout.truncatePrimary({
					text: displayValue,
					maxWidth,
					columnWidth,
					item,
					isSelected,
				})
			: truncateToWidth(displayValue, maxWidth, "");

		return truncateToWidth(truncatedValue, maxWidth, "");
	}

	private getDisplayValue(item: SelectItem): string {
		return toDisplayLine(item.label || item.value);
	}

	private notifySelectionChange(): void {
		const selectedItem = this.filteredItems[this.selectedIndex];
		if (selectedItem && this.onSelectionChange) {
			this.onSelectionChange(selectedItem);
		}
	}

	getSelectedItem(): SelectItem | null {
		const item = this.filteredItems[this.selectedIndex];
		return item || null;
	}
}

const identity = (text: string): string => text;

/** Parent directory of a `/`-separated display path, with a trailing slash; empty at the top level. */
function parentDirectory(displayPath: string): string {
	const trimmed = displayPath.replace(/\/+$/, "");
	const slash = trimmed.lastIndexOf("/");
	return slash === -1 ? "" : trimmed.slice(0, slash + 1);
}

/** Keeps the end of `text` (the nearest directories) when it does not fit. */
function truncateLeft(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	let tail = "";
	for (const char of Array.from(text).reverse()) {
		if (visibleWidth(tail) + visibleWidth(char) > maxWidth - 1) break;
		tail = char + tail;
	}
	return `…${tail}`;
}
