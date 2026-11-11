import type { SlashCommand } from "@octocodeai/octocode-tui";
import { SearchableSelectorComponent } from "./searchable-selector.ts";

export class CommandSelectorComponent extends SearchableSelectorComponent {
	constructor(
		title: string,
		commands: readonly SlashCommand[],
		onSelect: (name: string) => void,
		onCancel: () => void,
		query = "",
	) {
		super(
			title,
			commands.map((command) => ({
				value: command.name,
				label: `/${command.name}`,
				description: [command.description, command.argumentHint].filter(Boolean).join(" · "),
			})),
			onSelect,
			onCancel,
			{ query, confirmLabel: "insert command", commandColumns: true },
		);
	}
}
