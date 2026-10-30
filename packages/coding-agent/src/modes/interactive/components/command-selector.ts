import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	SelectList,
	Spacer,
	Text,
	type SlashCommand,
} from "@octocodeai/octocode-tui";
import { getSelectListTheme, theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

export class CommandSelectorComponent extends Container implements Focusable {
	private readonly input = new Input();
	private list!: SelectList;
	private readonly listContainer = new Container();
	private readonly commands: readonly SlashCommand[];
	private readonly onSelect: (name: string) => void;
	private readonly onCancel: () => void;
	get focused(): boolean {
		return this.input.focused;
	}
	set focused(value: boolean) {
		this.input.focused = value;
	}

	constructor(
		title: string,
		commands: readonly SlashCommand[],
		onSelect: (name: string) => void,
		onCancel: () => void,
		query = "",
	) {
		super();
		this.commands = commands;
		this.onSelect = onSelect;
		this.onCancel = onCancel;
		this.addChild(new DynamicBorder());
		this.addChild(new Text(theme.bold(theme.fg("accent", title)), 1, 0));
		this.addChild(new Spacer(1));
		this.input.setValue(query);
		this.input.onSubmit = () => this.list.handleInput("\r");
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(
			new Text(`${keyHint("tui.select.confirm", "insert command")} · ${keyHint("tui.select.cancel", "close")}`, 1, 0),
		);
		this.addChild(new DynamicBorder());
		this.filter();
	}

	private filter(): void {
		const commands = fuzzyFilter(
			[...this.commands],
			this.input.getValue(),
			(command) => `${command.name} ${command.description ?? ""}`,
		);
		this.list = new SelectList(
			// The arguments a command takes, as autocomplete shows them, lead its description.
			commands.map((command) => ({
				value: command.name,
				label: `/${command.name}`,
				description: [command.argumentHint, command.description].filter(Boolean).join("  "),
			})),
			12,
			getSelectListTheme(),
			{ maxPrimaryColumnWidth: 36 },
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
