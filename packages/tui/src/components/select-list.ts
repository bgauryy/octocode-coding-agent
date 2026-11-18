import { GLYPH } from "../tokens/design.ts";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { stripTerminalSequences } from "../utils/ansi-codes.ts";
import { stripControlCharacters } from "../utils/chars.ts";
import { visibleWidth } from "../utils/width.ts";
import { truncateToWidth } from "../utils/truncate.ts";
import { ListView } from "./list-view.ts";

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
	private theme: SelectListTheme;
	private layout: SelectListLayoutOptions;
	private options: SelectListOptions;
	/** Cursor, window, page keys, mouse and foot; this class only draws the rows. */
	private readonly list: ListView<SelectItem>;
	/** The primary column width for the rows in view, measured once per render. */
	private primaryColumnWidth = DEFAULT_PRIMARY_COLUMN_WIDTH;

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
		this.theme = theme;
		this.layout = layout;
		this.list = new ListView<SelectItem>({
			items,
			maxRows: maxVisible,
			mark: false,
			wrap: true,
			window: "center",
			clickConfirms: "first",
			theme: {
				cursor: identity,
				position: (text) =>
					(this.options.hint ? (this.theme.hint ?? this.theme.scrollInfo) : this.theme.scrollInfo)(text),
				empty: (text) => this.theme.noMatch(text),
			},
			row: (item, { selected, width }) => {
				const description = item.description ? normalizeToSingleLine(item.description) : undefined;
				return this.renderItem(item, selected, width, description, this.primaryColumnWidth);
			},
		});
		this.applyOptions();
		this.list.onSelect = (item) => this.onSelect?.(item);
		this.list.onCancel = () => this.onCancel?.();
		this.list.onSelectionChange = (item) => this.onSelectionChange?.(item);
	}

	/** Replaces the empty-state row, e.g. with an indexing progress line. */
	setEmptyText(text: string | undefined): void {
		this.options = { ...this.options, emptyText: text };
		this.applyOptions();
	}

	setFilter(filter: string): void {
		this.list.setItems(this.items.filter((item) => item.value.toLowerCase().startsWith(filter.toLowerCase())));
		this.list.setSelectedIndex(0);
	}

	setSelectedIndex(index: number): void {
		this.list.setSelectedIndex(index);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { start, end } = this.list.visibleRange();
		this.primaryColumnWidth = this.getPrimaryColumnWidth(start, end);
		return this.list.render(width);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.list.handleMouse(event);
	}

	handleInput(keyData: string): void {
		this.list.handleInput(keyData);
	}

	/** Moves the selection one row, wrapping at both ends. */
	moveSelection(delta: -1 | 1): void {
		this.list.move(delta, true);
	}

	getSelectedItem(): SelectItem | null {
		return this.list.getSelectedItem() ?? null;
	}

	private applyOptions(): void {
		this.list.setEmpty({ message: toDisplayLine(this.options.emptyText ?? "No matching commands") });
		this.list.setHint(this.options.hint);
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

	/** The widest label among the rows in view, within the layout's bounds: a long label elsewhere in the list does not narrow these rows' descriptions. */
	private getPrimaryColumnWidth(startIndex: number, endIndex: number): number {
		const { min, max } = this.getPrimaryColumnBounds();
		const widestPrimary = this.list
			.getItems()
			.slice(startIndex, endIndex)
			.reduce((widest, item) => {
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
