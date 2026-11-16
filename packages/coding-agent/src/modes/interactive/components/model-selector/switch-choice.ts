import { Container, SelectList, Spacer, Text } from "@octocodeai/octocode-tui";
import type { Model } from "@octocodeai/octocode-ai";
import { theme } from "../../../../theme/theme.ts";
import { getSelectListTheme } from "../../../../theme/theme-tui-helpers.ts";

export type SwitchChoice = "chat" | "default" | "both";

const ITEMS = [
	{ value: "chat", label: "Switch this chat" },
	{ value: "default", label: "Set as default for new chats" },
	{ value: "both", label: "Both" },
];

/** The inline question shown under the model list after Enter: what to do with the highlighted model. */
export class SwitchChoicePrompt extends Container {
	private readonly list: SelectList;

	constructor(model: Model<any>, onChoose: (choice: SwitchChoice) => void, onBack: () => void) {
		super();
		this.addChild(new Text(theme.fg("accent", `Use ${model.provider}/${model.id}:`), 0, 0));
		this.list = new SelectList(ITEMS, ITEMS.length, getSelectListTheme());
		this.list.onSelect = (item) => onChoose(item.value as SwitchChoice);
		this.list.onCancel = onBack;
		this.addChild(this.list);
	}

	handleInput(keyData: string): void {
		this.list.handleInput(keyData);
	}
}

/** Holds the prompt under the list; empty until a model is chosen. */
export class SwitchChoiceSlot extends Container {
	private prompt?: SwitchChoicePrompt;

	get active(): boolean {
		return this.prompt !== undefined;
	}

	open(model: Model<any>, onChoose: (choice: SwitchChoice) => void): void {
		this.close();
		this.prompt = new SwitchChoicePrompt(model, onChoose, () => this.close());
		this.addChild(new Spacer(1));
		this.addChild(this.prompt);
	}

	close(): void {
		this.prompt = undefined;
		this.clear();
	}

	handleInput(keyData: string): void {
		this.prompt?.handleInput(keyData);
	}
}
