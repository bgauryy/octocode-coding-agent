import type { ResourceItem } from "../package-manager/resource-groups.ts";
import type { ToggleHost } from "./toggles.ts";

/** The heading a row lists under: the host whose format defines it, packages, or the MCP and skill sections. */
export type InventoryHost = ToggleHost | "packages" | "mcp" | "skills";

/** One row of `/harness`: something the user can switch, with what decides it and why it is in its state. */
export interface InventoryItem {
	id: string;
	/** A short name `/harness enable|disable` also accepts: plugin, skill or MCP server name. */
	name?: string;
	host: InventoryHost;
	kind: "plugin" | "extension" | "hooks" | "hook-file" | "hook" | "skill" | "mcp";
	label: string;
	/** 0 host-level, 1 a file or container, 2 one handler. */
	depth: 0 | 1 | 2;
	on: boolean;
	/** Short state beside the switch: review state, unsupported parts, scope. */
	detail: string;
	/** Supplied by the repository: project switches reach it. */
	project?: true;
	/** A hook that denies when it fails: switching it off needs confirmation. */
	gate?: true;
	/** Why the row cannot be switched (an untrusted project file). */
	locked?: string;
	/** The broader toggle keys that decide this item when its own key is unset, most specific first. */
	parents?: string[];
	/** For extensions and skills: the resource the existing `extensions` and `skills` patterns switch. */
	resource?: ResourceItem;
	/** For a plugin another host installed: the `plugins` entry switching it on adds. */
	install?: { path: string; protocol: "claude" | "codex" };
}

export interface Inventory {
	items: InventoryItem[];
	/** Toggle keys that match no item (an edited hook or a removed plugin). */
	stale: string[];
	/** Project keys ignored because they target items outside the repository. */
	ignored: string[];
	notes: string[];
}

export const EMPTY_INVENTORY =
	'Nothing configured yet. Add plugins under "plugins" in settings.json, hooks in a hook file, skills in skills/, or MCP servers in mcp.json.';
