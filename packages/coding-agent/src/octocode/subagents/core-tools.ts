import { currentToolRoles } from "../../../../mcp/src/api.ts";
import { isMcpToolName } from "../../../../common/src/mcp-names.ts";

/** Every child can save files, communicate, wait with timers, recover history and read memories; local research is added separately. */
export const CORE_TOOLS = ["file", "agent", "timer", "archive", "memory"] as const;
/**
 * Every child, lean and read-only ones included, can run commands (`read-only-role.ts` still refuses a read-only role's
 * mutations). Not in `CORE_TOOLS`: a profile may replace `bash` with another shell tool such as `powershell`.
 */
export const SHELL_TOOLS = ["bash"] as const;
/**
 * What a lean child keeps besides its own list: commands and the means to message its parent. No `timer`: a lean task is
 * short and its end reports on its own; a profile that needs one names it in `tools`.
 */
export const LEAN_FLOOR = [...SHELL_TOOLS, "agent"] as const;
/**
 * Tools every child gets by default, unlike `CORE_TOOLS` a profile may remove them (`excludeTools` or a `-` entry):
 * `skill` loads a listed skill by name, and stays out of requests while the child has none.
 */
export const DEFAULT_CHILD_TOOLS = ["skill"] as const;
/** `mcp` restarts the child's own MCP servers. */
export const MCP_ACCESS_TOOLS = ["mcp"] as const;

/**
 * The local research tools: every MCP tool the session's servers mark as a reader or a search (`roles` in a server
 * entry, `mcp/src/roles.ts`), never a tool picked by name. Empty while no server has roles.
 */
export function localResearchTools(): readonly string[] {
	const { readers, searches } = currentToolRoles();
	return [...readers, ...searches];
}

/**
 * The MCP tools an allowlist gains. One naming tools of the research server (the one with a reader and a search role)
 * curates that catalog on purpose and keeps only its reader and its first search; one naming other servers' tools keeps
 * all local research; one naming no MCP tool keeps every server (`mcp__*`).
 */
export function mcpFloor(selected: readonly string[] | undefined): readonly string[] {
	const research = currentToolRoles().research;
	if (research && selected?.some((name) => name.startsWith(research.prefix)))
		return [research.reader, research.search[0]];
	return selected?.some(isMcpToolName) ? localResearchTools() : ["mcp__*"];
}
