import { builtinEffect } from "../features/builtin-ids.ts";
import { CORE_SKILL_SOURCE } from "./core-skill-items.ts";
import { VENDORS } from "../discovery/vendors/registry.ts";
import { vendorDefaultOn } from "../discovery/vendors/switch.ts";
import { type VendorId, vendorToggleId } from "../discovery/vendors/types.ts";
import { ResourceSettings } from "../package-manager/resource-settings.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { InventoryItem } from "./inventory-types.ts";
import { isSwitchedOn } from "./toggles.ts";

export type SwitchScope = "global" | "project";

/** A whole harness (`harness:<id>`), switched from the `/harness` list or `/configuration`. */
export interface VendorSwitchTarget {
	vendor: VendorId;
	label: string;
}

/** The switch target of a harness by id or label (case-insensitive), or undefined; Octocode itself has no switch. */
export function vendorSwitchTarget(query: string): VendorSwitchTarget | undefined {
	const wanted = query.trim().toLowerCase();
	const vendor = VENDORS.find((entry) => entry.id === wanted || entry.label.toLowerCase() === wanted);
	return vendor?.switchable ? { vendor: vendor.id, label: vendor.label } : undefined;
}

/** Write `harness:<id>`: removed when the harness's default already gives the wanted state. */
function switchVendor(target: VendorSwitchTarget, on: boolean, scope: SwitchScope, manager: SettingsManager): string {
	if (scope === "project" && !manager.isProjectTrusted()) throw new Error("Trust this project first (/trust).");
	const id = vendorToggleId(target.vendor);
	// A project key falls back to the global key, then the default; a global key falls back to the default.
	const global = manager.getToggles()[id];
	const parentOn = scope === "project" && global !== undefined ? global : vendorDefaultOn(target.vendor);
	manager.setToggle(scope, id, on === parentOn ? undefined : on);
	const where = scope === "project" ? "for this project's own files" : "globally";
	return `${target.label} switched ${on ? "on" : "off"} ${where}.`;
}

/** Why `item` cannot be switched in `scope`, or undefined. The terminal list dims such rows and shows this reason. */
export function blockedReason(item: InventoryItem, scope: SwitchScope): string | undefined {
	if (item.locked) return item.locked;
	// The MCP owner writes a project override for any server, so both scopes reach every MCP row.
	if (item.kind === "mcp") return undefined;
	if (item.resource) {
		// A project entry would name the installed file, which a project's settings must not carry.
		if (scope === "project" && item.resource.metadata.source === CORE_SKILL_SOURCE)
			return "a core skill ships with Octocode: switch it globally.";
		return scope === "global" && item.resource.metadata.scope === "project"
			? "comes from this project: switch it for this project."
			: undefined;
	}
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
	item: InventoryItem | VendorSwitchTarget,
	on: boolean,
	scope: SwitchScope,
	manager: SettingsManager,
	options: { cwd: string; agentDir: string; force?: boolean },
): string {
	if ("vendor" in item) return switchVendor(item, on, scope, manager);
	if (item.kind === "mcp") throw new Error(`${item.label}: MCP servers switch through the MCP owner.`);
	if (scope === "project" && !manager.isProjectTrusted()) throw new Error("Trust this project first (/trust).");
	if (!on && item.gate && !options.force)
		throw new Error(`${item.label} is a gate hook that denies when it fails; pass --force to switch it off.`);
	const reason = blockedReason(item, scope);
	if (reason) throw new Error(`${item.label}: ${reason}`);
	const where = scope === "project" ? "this project" : "globally";
	if (item.install) {
		if (!on) return `${item.label} is not added to Octocode.`;
		manager.addPlugin(scope, item.install);
		return `${item.label} added to Octocode ${where}; adding it approves its hooks and MCP servers.`;
	}
	if (item.resource) {
		// No inherited-group map is needed: a user item is inherited by its own scope.
		const settings = new ResourceSettings(manager, options.cwd, options.agentDir, []);
		const own = item.resource.metadata.scope === (scope === "project" ? "project" : "user");
		if (own && item.resource.metadata.origin === "package") settings.togglePackageResource(item.resource, on);
		else if (own) settings.toggleTopLevelResource(item.resource, on);
		else settings.setProjectResourceOverride(item.resource, on ? "load" : "unload");
		const effect = on ? undefined : builtinEffect(item.resource.path);
		return `${item.label} switched ${on ? "on" : "off"} ${where}.${effect ? ` Switching it off ${effect}.` : ""}`;
	}
	const parentOn = isSwitchedOn(item.parents ?? [], manager.getToggles(), scope === "project");
	manager.setToggle(scope, item.id, on === parentOn ? undefined : on);
	return `${item.label} switched ${on ? "on" : "off"} ${where}.`;
}
