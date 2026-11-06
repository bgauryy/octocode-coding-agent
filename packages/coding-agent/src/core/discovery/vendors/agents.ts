import { join, resolve } from "node:path";
import { dirsToRepoOrFsRoot } from "../../../utils/repo-dirs.ts";
import { listsProject, skillItemsIn } from "../sources.ts";
import type { ConfigItem, DiscoverInput } from "../types.ts";
import { mcpSource } from "./mcp-items.ts";
import { vendorDefaultOn } from "./switch.ts";
import type { Vendor } from "./types.ts";

/**
 * The shared `.agents/skills` folders: the workspace's (cwd up to its repository root, or the filesystem root outside a
 * repository), then `~/.agents/skills`.
 */
function skills(input: DiscoverInput): ConfigItem[] {
	const user = join(input.home, ".agents", "skills");
	const project = listsProject(input)
		? dirsToRepoOrFsRoot(input.cwd)
				.map((dir) => join(dir, ".agents", "skills"))
				.filter((dir) => resolve(dir) !== resolve(user))
		: [];
	const root = { product: "octocode", vendor: "agents", origin: "agents" } as const;
	return [
		...skillItemsIn(project, { ...root, scope: "project" }, input, { mode: "agents" }),
		...skillItemsIn([user], { ...root, scope: "global" }, input, { mode: "agents" }),
	];
}

/** The `.agents` convention several agents share: skills, and the project's `.agents/mcp.json`. */
export const agentsVendor: Vendor = {
	id: "agents",
	label: ".agents",
	defaultOn: vendorDefaultOn("agents"),
	switchable: true,
	sources: [{ kind: "skill", discover: skills }, mcpSource("agents")],
};
