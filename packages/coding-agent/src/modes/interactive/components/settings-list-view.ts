import {
	type Component,
	ListView,
	type SettingItem,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@octocodeai/octocode-tui";
import { keyText, moveHint, type RankedHint, renderHintLine } from "../../../theme/theme-tui-helpers.ts";
import { selectedText } from "../../../theme/gradients.ts";
import { theme } from "../../../theme/theme.ts";
import { labelColumn, listTheme, syncEmpty } from "./list-kit.ts";
import { plainText } from "./styled-line.ts";

export interface SettingsListViewOptions {
	/** A `⌕` search line above the rows; typing filters by label. */
	search?: boolean;
	/** Starting query for a rebuilt searchable list. */
	initialQuery?: string;
}

/**
 * Settings as a page of `label  value` rows on `ListView`: `›` cursor, ends that stop, page keys by the rows in view,
 * an `a–b/total` foot while it scrolls, an optional `⌕` search line, the selected row's description, and one hint line
 * cut to the width. Enter (or Space with no query) cycles the value or opens the row's submenu; a click only selects.
 */
export class SettingsListView implements Component {
	private readonly list: ListView<SettingItem>;
	private readonly column: number;
	private submenu: Component | null = null;
	private listHeight = 0;

	private readonly onChange: (id: string, value: string) => void;

	constructor(
		items: SettingItem[],
		maxRows: number,
		onChange: (id: string, value: string) => void,
		onCancel: () => void,
		options: SettingsListViewOptions = {},
	) {
		this.onChange = onChange;
		this.column = labelColumn(
			items.map((item) => item.label),
			8,
			36,
		);
		this.list = new ListView<SettingItem>({
			items,
			maxRows: Math.max(1, maxRows),
			theme: listTheme(),
			clickConfirms: false,
			...(options.search ? { search: { text: (item: SettingItem) => item.label, placeholder: "type to search" } } : {}),
			row: (item, state) => this.row(item, state),
		});
		this.list.onSelect = (item) => this.activate(item);
		this.list.onCancel = onCancel;
		if (options.search && options.initialQuery) this.list.setQuery(options.initialQuery);
		syncEmpty(this.list, "settings");
	}

	getSearchQuery(): string {
		return this.list.getQuery();
	}

	getSelectedId(): string | undefined {
		return this.list.getSelectedItem()?.id;
	}

	/** Shows `value` on the row with `id`; `values` replaces what Enter cycles through, when the row's choices changed. */
	updateValue(id: string, value: string, values?: string[]): void {
		const item = this.list.getItems().find((candidate) => candidate.id === id);
		if (!item) return;
		item.currentValue = value;
		if (values) item.values = values;
	}

	/** Moves the cursor to the row with `id`, when it is shown. */
	selectItem(id: string): void {
		const index = this.list.getItems().findIndex((item) => item.id === id);
		if (index !== -1) this.list.setSelectedIndex(index);
	}

	invalidate(): void {
		this.submenu?.invalidate();
	}

	private row(item: SettingItem, state: { selected: boolean; width: number }): string {
		const head = truncateToWidth(plainText(item.label), this.column, "…");
		const pad = " ".repeat(Math.max(0, this.column - visibleWidth(head)));
		const label = state.selected ? theme.bold(selectedText(head)) : theme.fg("text", head);
		const value = theme.fg(state.selected ? "accent" : "muted", plainText(item.currentValue));
		return truncateToWidth(`${label}${pad}  ${value}`, state.width, "…");
	}

	/** Enter's verb first, Esc's last; with nothing shown only Esc remains (the empty line names `esc clears`). */
	private hints(): RankedHint[] {
		const close: RankedHint = [keyText("tui.select.cancel"), "close", 0];
		if (!this.list.getSelectedItem()) return [close];
		const enter = keyText("tui.select.confirm");
		return [[this.list.getQuery() ? enter : `${enter}/space`, "change", 1], moveHint(), close];
	}

	render(width: number): string[] {
		if (this.submenu) return this.submenu.render(width);
		const lines = this.list.render(width);
		this.listHeight = lines.length;
		const description = this.list.getSelectedItem()?.description;
		if (description) {
			lines.push("");
			for (const line of wrapTextWithAnsi(plainText(description), Math.max(1, width - 4))) {
				lines.push(theme.fg("muted", `  ${line}`));
			}
		}
		lines.push("", renderHintLine(this.hints(), width));
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.submenu) {
			const result = this.submenu.handleMouse?.(event);
			return result ? { ...result, focus: true } : undefined;
		}
		return event.y < this.listHeight ? this.list.handleMouse(event) : undefined;
	}

	handleInput(data: string): void {
		if (this.submenu) {
			this.submenu.handleInput?.(data);
			return;
		}
		if (data === " " && !this.list.getQuery()) {
			const item = this.list.getSelectedItem();
			if (item) this.activate(item);
			return;
		}
		const query = this.list.getQuery();
		this.list.handleInput(data);
		// A new query highlights its best match, so typing a label and pressing Enter changes that setting.
		if (this.list.getQuery() !== query) {
			this.list.setSelectedIndex(0);
			syncEmpty(this.list, "settings");
		}
	}

	private activate(item: SettingItem): void {
		if (item.submenu) {
			this.submenu = item.submenu(item.currentValue, (value, options) => {
				if (value !== undefined) {
					item.currentValue = value;
					this.onChange(item.id, value);
				}
				this.submenu = null;
				const target = options?.navigateTo;
				this.selectItem(target ?? item.id);
				const next = this.list.getSelectedItem();
				// `navigateTo` opens the target row's submenu at once.
				if (target && next?.id === target) this.activate(next);
			});
		} else if (item.values && item.values.length > 0) {
			const value = item.values[(item.values.indexOf(item.currentValue) + 1) % item.values.length];
			item.currentValue = value;
			this.onChange(item.id, value);
		}
	}
}
