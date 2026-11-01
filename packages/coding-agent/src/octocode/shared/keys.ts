import { getKeybindings, type Keybinding, type KeybindingsManager } from "@octocodeai/octocode-tui";
import { KEYBINDINGS } from "../../core/keybindings.ts";
import { formatKeyText } from "../../modes/interactive/components/keybinding-hints.ts";

/** Display the effective binding; a disabled action must not advertise its default key. */
export function shortcutText(action: Keybinding, manager: KeybindingsManager = getKeybindings()): string {
	const defaults = KEYBINDINGS[action].defaultKeys;
	const keys = manager.getDefinition(action)
		? manager.getKeys(action)
		: Array.isArray(defaults)
			? defaults
			: [defaults];
	return keys.length ? formatKeyText(keys.join("/")) : "unbound";
}
