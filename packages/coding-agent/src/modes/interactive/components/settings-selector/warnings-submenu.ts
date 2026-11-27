import { Container, type SettingItem } from "@octocodeai/octocode-tui";
import { SettingsListView } from "../settings-list-view.ts";
import { SETTINGS_DEFAULTS } from "../../../../core/settings-defaults.ts";
import type { WarningSettings } from "../../../../core/settings-manager.ts";

/**
 * A submenu component for selecting from a list of options.
 */
export class WarningSettingsSubmenu extends Container {
	private settingsList: SettingsListView;
	private state: WarningSettings;

	constructor(warnings: WarningSettings, onChange: (warnings: WarningSettings) => void, onCancel: () => void) {
		super();

		this.state = { ...warnings };

		const items: SettingItem[] = [
			{
				id: "anthropic-extra-usage",
				label: "Claude subscription token",
				description: "Show the notice that a saved Claude subscription token is refused",
				currentValue:
					(this.state.anthropicExtraUsage ?? SETTINGS_DEFAULTS.warnings.anthropicExtraUsage) ? "true" : "false",
				values: ["true", "false"],
			},
		];

		this.settingsList = new SettingsListView(
			items,
			Math.min(items.length, 10),
			(id, newValue) => {
				switch (id) {
					case "anthropic-extra-usage":
						this.state = { ...this.state, anthropicExtraUsage: newValue === "true" };
						onChange({ ...this.state });
						break;
				}
			},
			onCancel,
		);

		this.addChild(this.settingsList);
	}

	handleInput(data: string): void {
		this.settingsList.handleInput(data);
	}
}
