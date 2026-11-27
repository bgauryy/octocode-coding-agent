import { join } from "node:path";
import { dirsToRepoRoot } from "../../../utils/repo-dirs.ts";
import { externalSkillsEnabled, listsProject, skillItemsIn, withinTrust } from "../sources.ts";
import type { ConfigItem, DiscoverInput } from "../types.ts";
import { mcpSource } from "./mcp-items.ts";
import { vendorDefaultOn } from "./switch.ts";
import type { Vendor } from "./types.ts";

const ROOT = { product: "octocode", vendor: "cursor", origin: "cursor" } as const;

/** The workspace's `.cursor/skills` (cwd up to its repository root), then `~/.cursor/skills`. */
function skills(input: DiscoverInput): ConfigItem[] {
	if (!externalSkillsEnabled(input.env ?? process.env)) return [];
	const project = listsProject(input)
		? dirsToRepoRoot(input.cwd)
				.filter((dir) => withinTrust(input, dir))
				.map((dir) => join(dir, ".cursor", "skills"))
		: [];
	return [
		...skillItemsIn(project, { ...ROOT, scope: "project" }, input),
		...skillItemsIn([join(input.home, ".cursor", "skills")], { ...ROOT, scope: "global" }, input),
	];
}

/** Cursor: skills and `mcp.json`; Cursor rules are not read. Off until the user enables it in `/harness`. */
export const cursorVendor: Vendor = {
	id: "cursor",
	label: "Cursor",
	defaultOn: vendorDefaultOn("cursor"),
	switchable: true,
	sources: [{ kind: "skill", discover: skills }, mcpSource("cursor")],
};
