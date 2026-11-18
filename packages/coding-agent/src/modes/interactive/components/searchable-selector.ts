import { Container, type Focusable, ListView, Spacer, Text, type SelectItem } from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { HintBar, keyText, moveHint, type RankedHint } from "../../../theme/theme-tui-helpers.ts";
import { columnRow, labelColumn, listRows, listTheme, syncEmpty, typeKeepingSelection } from "./list-kit.ts";

export interface SearchableSelectorOptions {
	query?: string;
	confirmLabel?: string;
	/** Slash-command rows: a wider label column, and the empty line names commands. */
	commandColumns?: boolean;
	/** Terminal rows, for the list's height; without it the list shows twelve rows. */
	rows?: number;
}

/**
 * A picker over a long list (/help commands, references): the `⌕` search line, twelve rows at most, Enter confirms the
 * highlighted row. Source values stay complete; only the rows in view are painted.
 */
export class SearchableSelectorComponent extends Container implements Focusable {
	private readonly hints = new HintBar([]);
	private confirmHint: RankedHint = ["enter", "select"];
	private cancelHint: RankedHint = ["esc", "cancel"];
	private readonly list: ListView<SelectItem>;
	private readonly things: string;
	/** The name column for the rows in view, recomputed when the matches or the window change. */
	private column: { rows: readonly SelectItem[]; start: number; end: number; width: number } | undefined;
	get focused(): boolean {
		return this.list.focused;
	}
	set focused(value: boolean) {
		this.list.focused = value;
	}

	constructor(
		title: string,
		items: readonly SelectItem[],
		onSelect: (value: string) => void,
		onCancel: () => void,
		options: SearchableSelectorOptions = {},
	) {
		super();
		this.things = options.commandColumns ? "commands" : "items";
		const max = options.commandColumns ? 36 : 32;
		this.list = new ListView<SelectItem>({
			items,
			maxRows: listRows(options.rows, 8),
			theme: listTheme(),
			search: { text: (item) => `${item.label} ${item.description ?? ""}`, placeholder: "type to search" },
			row: (item, state) => columnRow(item.label, item.description, state, this.columnWidth(max)),
		});
		this.list.onSelect = (item) => onSelect(item.value);
		this.list.onCancel = onCancel;
		if (options.query) this.list.setQuery(options.query);
		syncEmpty(this.list, this.things);
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.confirmHint = [keyText("tui.select.confirm"), options.confirmLabel ?? "select", 1];
		this.cancelHint = [keyText("tui.select.cancel"), "close", 0];
		this.addChild(this.hints);
		this.syncHints();
		this.addChild(new DynamicBorder());
	}

	/** Fits the labels of the rows in view, so short matches keep their descriptions close. */
	private columnWidth(max: number): number {
		const rows = this.list.getItems();
		const { start, end } = this.list.visibleRange();
		const cached = this.column;
		if (cached?.rows === rows && cached.start === start && cached.end === end) return cached.width;
		const labels = rows.slice(start, end).map((item) => item.label);
		this.column = { rows, start, end, width: labelColumn(labels, 12, max) };
		return this.column.width;
	}

	handleInput(data: string): void {
		typeKeepingSelection(this.list, data);
		syncEmpty(this.list, this.things);
		this.syncHints();
	}

	/** While the list is empty, Enter does nothing: only Esc (and the empty line's recovery key) remain. */
	private syncHints(): void {
		this.hints.setHints(
			this.list.getItems().length ? [moveHint(1), this.confirmHint, this.cancelHint] : [this.cancelHint],
		);
	}
}
