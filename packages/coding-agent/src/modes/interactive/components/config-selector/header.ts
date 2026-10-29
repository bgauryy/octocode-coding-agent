import { type Component, truncateToWidth, visibleWidth } from "@octocodeai/octocode-tui";
import { CONFIG_DIR_NAME } from "../../../../config.ts";
import { theme } from "../../../../theme/theme.ts";
import { keyHint, rawKeyHint } from "../keybinding-hints.ts";
import type { ConfigWriteScope } from "../../../../core/package-manager/resource-groups.ts";

export class ConfigSelectorHeader implements Component {
	private writeScope: ConfigWriteScope;
	private projectModeAvailable: boolean;

	constructor(writeScope: ConfigWriteScope, projectModeAvailable: boolean) {
		this.writeScope = writeScope;
		this.projectModeAvailable = projectModeAvailable;
	}

	setWriteScope(writeScope: ConfigWriteScope): void {
		this.writeScope = writeScope;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const title = theme.bold(this.writeScope === "project" ? "Project Local Resources" : "Global Resources");
		const sep = theme.fg("muted", " · ");
		const switchHint = this.projectModeAvailable ? keyHint("tui.input.tab", "switch mode") + sep : "";
		const actionHint =
			this.writeScope === "project" ? rawKeyHint("space", "cycle inherit/+/-") : rawKeyHint("space", "toggle");
		const hint = switchHint + actionHint + sep + rawKeyHint("esc", "close");
		const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(hint));
		const scopeHint =
			this.writeScope === "project"
				? theme.fg("muted", `${CONFIG_DIR_NAME}/settings.json · inherited global resources are dimmed`)
				: theme.fg("muted", `~/${CONFIG_DIR_NAME}/agent/settings.json`);

		return [truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, ""), truncateToWidth(scopeHint, width, "")];
	}
}
