import { ResourceSettings } from "../package-manager/resource-settings.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { InventoryItem } from "./inventory.ts";
import { isSwitchedOn } from "./toggles.ts";

export type SwitchScope = "global" | "project";

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
	if (item.locked) throw new Error(`${item.label}: ${item.locked}`);
	if (scope === "project" && !manager.isProjectTrusted()) throw new Error("Trust this project first (/trust).");
	if (!on && item.gate && !options.force)
		throw new Error(`${item.label} is a gate hook that denies when it fails; pass --force to switch it off.`);
	const where = scope === "project" ? "this project" : "globally";
	if (item.resource) {
		// No inherited-group map is needed: a user item is inherited by its own scope.
		const settings = new ResourceSettings(manager, options.cwd, options.agentDir, []);
		const own = item.resource.metadata.scope === (scope === "project" ? "project" : "user");
		if (own && item.resource.metadata.origin === "package") settings.togglePackageResource(item.resource, on);
		else if (own) settings.toggleTopLevelResource(item.resource, on);
		else if (scope === "project") settings.setProjectResourceOverride(item.resource, on ? "load" : "unload");
		else throw new Error(`${item.label} comes from this project; switch it with --local.`);
		return `${item.label} switched ${on ? "on" : "off"} ${where}.`;
	}
	if (scope === "project" && !item.project && !/^hooks:[a-z]+$/.test(item.id))
		throw new Error(`${item.label} is not part of this repository; project switches only reach project items.`);
	const parentOn = isSwitchedOn(item.parents ?? [], manager.getToggles(), scope === "project");
	manager.setToggle(scope, item.id, on === parentOn ? undefined : on);
	return `${item.label} switched ${on ? "on" : "off"} ${where}.`;
}
