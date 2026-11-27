import { hookHostToggleId, isSwitchedOn, type Toggles } from "../../extensibility/toggles.ts";
import type { ConfigItem } from "../types.ts";
import { type VendorId, vendorToggleId } from "./types.ts";

/** What each harness does when `toggles` holds no `harness:<id>` key (user decision: foreign agents stay off until enabled). */
const DEFAULT_ON: Readonly<Record<VendorId, boolean>> = {
	octocode: true,
	agents: true,
	"mcp-json": true,
	pi: true,
	claude: false,
	codex: false,
	cursor: false,
};

/** The `toggles` key of Claude Code's auto memory: off by default even when Claude Code is on. */
export const CLAUDE_MEMORY_TOGGLE_ID = `${vendorToggleId("claude")}:memory`;

export const vendorDefaultOn = (id: VendorId): boolean => DEFAULT_ON[id];

/**
 * Whether a harness loads: its `harness:<id>` key, a project key first for an item inside the repository (as
 * `isSwitchedOn` decides every toggle), else its default. Octocode is always on.
 */
export function vendorOn(id: VendorId, toggles: Toggles | undefined, inProject: boolean): boolean {
	return id === "octocode" || isSwitchedOn([vendorToggleId(id)], toggles, inProject, DEFAULT_ON[id]);
}

/**
 * Whether one discovered item's harness lets it load. A Claude or Codex hook file also answers to the narrower
 * `hooks:<host>` key, so an explicit host switch wins over the harness default; Claude Code's memory has its own key.
 */
export function vendorItemOn(item: ConfigItem, toggles: Toggles | undefined): boolean {
	const { vendor, scope, origin } = item.provenance;
	if (vendor === "octocode") return true;
	const inProject = scope === "project";
	if (item.kind === "memory") return isSwitchedOn([CLAUDE_MEMORY_TOGGLE_ID], toggles, false, false);
	const ids =
		item.kind === "hook" && (origin === "claude" || origin === "codex")
			? [hookHostToggleId(origin), vendorToggleId(vendor)]
			: [vendorToggleId(vendor)];
	return isSwitchedOn(ids, toggles, inProject, DEFAULT_ON[vendor]);
}
