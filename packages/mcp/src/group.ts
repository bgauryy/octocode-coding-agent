import type { McpServerEntry } from "./config.ts";

/**
 * Where a server comes from, in the words skills use for their groups: `core` ships with the host (a built-in preset such
 * as the default research server), `workspace` is defined in a trusted project file, and `global` is defined in a user
 * file (the host's own, Pi's or another agent's) or registered by a plugin or session. A project override that only
 * switches a server keeps the group of the file that defines it.
 */
export type McpServerGroup = "core" | "workspace" | "global";

export function mcpServerGroup(entry: Pick<McpServerEntry, "scope">): McpServerGroup {
	if (entry.scope === "default") return "core";
	return entry.scope === "project" ? "workspace" : "global";
}

const GROUP_LABELS: Readonly<Record<McpServerGroup, string>> = {
	core: "Core",
	workspace: "Workspace",
	global: "Global",
};

/** The group as a row shows it: `Core`, `Workspace` or `Global`. */
export const mcpGroupLabel = (group: McpServerGroup): string => GROUP_LABELS[group];

/**
 * Where a row says the server is defined: `built in` for a preset, `plugin <path>` for a server a plugin or session
 * registered, else the file (shortened by `short`, for example to `~/...`).
 */
export function mcpServerSource(
	entry: Pick<McpServerEntry, "scope" | "source">,
	short: (file: string) => string = (file) => file,
): string {
	if (entry.scope === "default") return "built in";
	return entry.scope === "extension" ? `plugin ${short(entry.source)}` : short(entry.source);
}
