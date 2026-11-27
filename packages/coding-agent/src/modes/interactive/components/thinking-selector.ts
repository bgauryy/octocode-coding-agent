import type { ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { Container, getKeybindings, ListView, Spacer, Text } from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { HintBar, keyText, moveHint } from "../../../theme/theme-tui-helpers.ts";
import { columnRow, listTheme } from "./list-kit.ts";

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning (~1k tokens)",
	low: "Light reasoning (~2k tokens)",
	medium: "Moderate reasoning (~8k tokens)",
	high: "Deep reasoning (~16k tokens)",
	xhigh: "Extra-high reasoning (~32k tokens)",
	max: "Maximum reasoning",
};

interface LevelItem {
	level: ThinkingLevel;
	label: string;
	description: string;
}

/**
 * The thinking-level picker (/effort): a short list with no search line (it never holds more than seven levels), the
 * current level ticked, Enter for this chat and the save key for the default.
 */
export class ThinkingSelectorComponent extends Container {
	private readonly list: ListView<LevelItem>;
	private readonly onSelectAsDefault?: (level: ThinkingLevel) => void;

	constructor(
		currentLevel: ThinkingLevel,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
		onSelectAsDefault?: (level: ThinkingLevel) => void,
		defaultThinkingLevel?: ThinkingLevel,
	) {
		super();
		this.onSelectAsDefault = onSelectAsDefault;
		const items = availableLevels.map((level) => ({
			level,
			label: `${level === currentLevel ? "✓ " : "  "}${level}`,
			description:
				level === defaultThinkingLevel ? `${LEVEL_DESCRIPTIONS[level]} · default` : LEVEL_DESCRIPTIONS[level],
		}));

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Thinking level")), 1, 0));
		this.addChild(new Text(theme.fg("muted", `${keyText("app.thinking.cycle")} cycles levels in this chat`), 1, 0));
		this.addChild(new Spacer(1));

		this.list = new ListView<LevelItem>({
			items,
			maxRows: Math.max(1, items.length),
			theme: listTheme(),
			empty: { message: "No thinking levels for this model" },
			row: (item, { selected, width }) =>
				`${item.label.slice(0, 2)}${columnRow(item.level, item.description, { selected, width: Math.max(1, width - 2) }, 10)}`,
		});
		this.list.setSelectedIndex(Math.max(0, availableLevels.indexOf(currentLevel)));
		this.list.onSelect = (item) => onSelect(item.level);
		this.list.onCancel = onCancel;
		this.addChild(this.list);
		this.addChild(new Spacer(1));
		this.addChild(
			new HintBar([
				moveHint(1),
				[keyText("tui.select.confirm"), "select", 1],
				...(onSelectAsDefault ? [[keyText("app.thinking.save"), "set as default", 2] as const] : []),
				[keyText("tui.select.cancel"), "cancel", 0],
			]),
		);
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		if (getKeybindings().matches(keyData, "app.thinking.save") && this.onSelectAsDefault) {
			const item = this.list.getSelectedItem();
			if (item) this.onSelectAsDefault(item.level);
			return;
		}
		this.list.handleInput(keyData);
	}

	getList(): ListView<LevelItem> {
		return this.list;
	}
}
