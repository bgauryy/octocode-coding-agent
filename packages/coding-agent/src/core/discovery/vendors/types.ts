import type { ConfigKind, DiscoverySource } from "../types.ts";

/** Every harness Octocode reads, one discovery file each in this folder. */
export const VENDOR_IDS = ["octocode", "agents", "mcp-json", "pi", "claude", "codex", "cursor"] as const;
export type VendorId = (typeof VENDOR_IDS)[number];

/** One harness: who defines the files, whether they load by default, and the kinds it supplies. */
export interface Vendor {
	id: VendorId;
	/** The name users see, such as "Claude Code" or ".agents". */
	label: string;
	/** Whether it loads when the `toggles` setting holds no `harness:<id>` key. */
	defaultOn: boolean;
	/** False for Octocode itself: always on, with no `/harness` switch. */
	switchable: boolean;
	/** Kinds that load whatever the switch says, such as Pi's models, settings and keybindings. */
	alwaysOn?: readonly ConfigKind[];
	/** One source per kind this vendor supplies; their items carry `provenance.vendor` set to `id`. */
	sources: readonly DiscoverySource[];
}

/** One harness as the startup banner, `/harness` and the agent's prompt describe it. */
export interface HarnessStatus {
	id: VendorId;
	label: string;
	on: boolean;
	/** On only through a project key: the harness's global items (the user's own folders) stay off. */
	projectOnly?: boolean;
	defaultOn: boolean;
	switchable: boolean;
	/** Items found per kind, loaded or not (MCP counts servers). */
	found: Partial<Record<ConfigKind, number>>;
	/** Items that load now per kind: zero for a switched-off vendor except its `alwaysOn` kinds. */
	loaded: Partial<Record<ConfigKind, number>>;
}

/** The `toggles` key that switches a whole vendor; a project key reaches only items inside the repository. */
export const vendorToggleId = (id: VendorId): string => `harness:${id}`;
