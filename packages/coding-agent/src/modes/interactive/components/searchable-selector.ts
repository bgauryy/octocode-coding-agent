import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	SelectList,
	Spacer,
	Text,
	type SelectItem,
} from "@octocodeai/octocode-tui";
import { getSelectListTheme, theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { HintBar, keyText } from "../../../theme/theme-tui-helpers.ts";

/** Source values stay complete; only twelve matching rows are painted, regardless of conversation length. */
export class SearchableSelectorComponent extends Container implements Focusable {
	private readonly input = new Input();
	private list!: SelectList;
	private readonly listContainer = new Container();
	private readonly items: readonly SelectItem[];
	private readonly onSelect: (value: string) => void;
	private readonly onCancel: () => void;
	private readonly options: { query?: string; confirmLabel?: string; commandColumns?: boolean };
	get focused(): boolean {
		return this.input.focused;
	}
	set focused(value: boolean) {
		this.input.focused = value;
	}

	constructor(
		title: string,
		items: readonly SelectItem[],
		onSelect: (value: string) => void,
		onCancel: () => void,
		options: { query?: string; confirmLabel?: string; commandColumns?: boolean } = {},
	) {
		super();
		this.items = items;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.options = options;
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
		this.addChild(new Spacer(1));
		this.input.setValue(options.query ?? "");
		this.input.onSubmit = () => this.list.handleInput("\r");
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(
			new HintBar([
				[keyText("tui.select.confirm"), options.confirmLabel ?? "choose", 1],
				[keyText("tui.select.cancel"), "close", 0],
			]),
		);
		this.addChild(new DynamicBorder());
		this.filter();
	}

	private filter(): void {
		const items = fuzzyFilter(
			[...this.items],
			this.input.getValue(),
			(item) => `${item.label} ${item.description ?? ""}`,
		);
		this.list = new SelectList(
			items,
			12,
			getSelectListTheme(),
			this.options.commandColumns ? { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 36 } : undefined,
		);
		this.list.onSelect = (item) => this.onSelect(item.value);
		this.list.onCancel = this.onCancel;
		this.listContainer.clear();
		this.listContainer.addChild(this.list);
	}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (
			(["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const).some((key) =>
				keys.matches(data, key),
			)
		) {
			this.list.handleInput(data);
			return;
		}
		this.input.handleInput(data);
		this.filter();
	}
}
