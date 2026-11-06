import type { InventoryItem } from "../../core/extensibility/inventory-types.ts";
import { type SwitchScope, switchItem, vendorSwitchTarget } from "../../core/extensibility/switch.ts";
import { CLAUDE_MEMORY_TOGGLE_ID } from "../../core/discovery/vendors/index.ts";
import { foundSummary } from "../../core/discovery/vendors/prompt.ts";
import type { HarnessStatus } from "../../core/discovery/vendors/types.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { Settings } from "../../core/settings-schema.ts";

/** Claude Code's auto memory is switched globally only: the loader reads the global key (`vendorItemOn`). */
const memoryOn = (toggles: Settings["toggles"]) => toggles?.[CLAUDE_MEMORY_TOGGLE_ID] === true;

/**
 * The first rows of `/harness`: one per harness Octocode reads (on or off, its default, what its folders hold), and
 * under Claude Code its auto-memory switch. A row's ID is its `toggles` key, so a saved harness switch is never stale.
 */
export function vendorItems(statuses: readonly HarnessStatus[], toggles: Settings["toggles"]): InventoryItem[] {
	return statuses.flatMap((status): InventoryItem[] => {
		const found = foundSummary(status);
		const row: InventoryItem = {
			id: `harness:${status.id}`,
			name: status.id,
			host: "harness",
			kind: "harness",
			depth: 0,
			label: status.label,
			on: status.on,
			detail: [
				...(status.projectOnly ? ["on for this project only"] : []),
				`default ${status.defaultOn ? "on" : "off"}`,
				found ? `found ${found}` : "nothing found",
			].join(" · "),
			...(status.switchable ? {} : { locked: "always on" }),
		};
		if (status.id !== "claude") return [row];
		const memory: InventoryItem = {
			id: CLAUDE_MEMORY_TOGGLE_ID,
			name: "claude:memory",
			host: "harness",
			kind: "harness",
			depth: 1,
			label: "Claude Code auto memory",
			on: memoryOn(toggles),
			detail: "default off · adds this repository's MEMORY.md (read only) to the context",
		};
		return [row, memory];
	});
}

/** Switches a harness row: the vendor key through `switchItem`, or the Claude memory key (global only; unset when off, its default). */
export function switchHarness(
	item: InventoryItem,
	on: boolean,
	scope: SwitchScope,
	manager: SettingsManager,
	options: { cwd: string; agentDir: string },
): string {
	if (item.id === CLAUDE_MEMORY_TOGGLE_ID) {
		if (scope === "project") throw new Error("Claude Code auto memory is switched globally: run it without --project.");
		manager.setToggle("global", CLAUDE_MEMORY_TOGGLE_ID, on ? true : undefined);
		return `Claude Code auto memory switched ${on ? "on" : "off"} globally.`;
	}
	const target = vendorSwitchTarget(item.name ?? "");
	if (!target) throw new Error(`${item.label} has no switch.`);
	return switchItem(target, on, scope, manager, options);
}
