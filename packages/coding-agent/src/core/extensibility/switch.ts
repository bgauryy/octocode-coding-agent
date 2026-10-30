import { ResourceSettings } from "../package-manager/resource-settings.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { InventoryItem } from "./inventory.ts";
import { isSwitchedOn } from "./toggles.ts";

export type SwitchScope = "global" | "project";

/** Why `item` cannot be switched in `scope`, or undefined. The terminal list dims such rows and shows this reason. */
export function blockedReason(item: InventoryItem, scope: SwitchScope): string | undefined {
	if (item.locked) return item.locked;
	if (item.resource)
		return scope === "global" && item.resource.metadata.scope === "project"
			? "comes from this project: switch it for this project."
			: undefined;
	// A project host key (`hooks:claude`) still reaches the project's own hook files.
	if (scope === "project" && !item.install && !item.project && !/^hooks:[a-z]+$/.test(item.id))
		return "not part of this repository: switch it globally.";
	return undefined;
}

/**
 * Switch one inventory item and return what changed. Plugins and hooks write one `toggles` key: removed when the
 * broader keys already give the wanted state, so the settings keep only real exceptions. Extensions write the
 * `extensions` patterns `octocode config` uses. Throws a user-facing message when the switch is not allowed.
 */
export function switchItem(
	item: InventoryItem,
	on: boolean,
	scope: SwitchScope,
	manager: SettingsManager,
	options: { cwd: string; agentDir: string; force?: boolean },
): string {
	if (scope === "project" && !manager.isProjectTrusted()) throw new Error("Trust this project first (/trust).");
	if (!on && item.gate && !options.force)
		throw new Error(`${item.label} is a gate hook that denies when it fails; pass --force to switch it off.`);
	const reason = blockedReason(item, scope);
	if (reason) throw new Error(`${item.label}: ${reason}`);
	const where = scope === "project" ? "this project" : "globally";
	if (item.install) {
		if (!on) return `${item.label} is not added to Octocode.`;
		manager.addPlugin(scope, item.install);
		return `${item.label} added to Octocode ${where}; its hooks and MCP servers still need review in /plugins.`;
	}
	if (item.resource) {
		// No inherited-group map is needed: a user item is inherited by its own scope.
		const settings = new ResourceSettings(manager, options.cwd, options.agentDir, []);
		const own = item.resource.metadata.scope === (scope === "project" ? "project" : "user");
		if (own && item.resource.metadata.origin === "package") settings.togglePackageResource(item.resource, on);
		else if (own) settings.toggleTopLevelResource(item.resource, on);
		else settings.setProjectResourceOverride(item.resource, on ? "load" : "unload");
		return `${item.label} switched ${on ? "on" : "off"} ${where}.`;
	}
	const parentOn = isSwitchedOn(item.parents ?? [], manager.getToggles(), scope === "project");
	manager.setToggle(scope, item.id, on === parentOn ? undefined : on);
	return `${item.label} switched ${on ? "on" : "off"} ${where}.`;
}
