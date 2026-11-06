import {
	isOctocodeTool,
	LOCAL_RESEARCH_TOOLS,
	OCTOCODE_TOOL_PREFIX,
} from "../../../../mcp/src/presets/octocode/names.ts";
import { isMcpToolName } from "../../../../mcp/src/servers.ts";

/** Every child can save files, communicate, track steps, wait with timers and recover history; local research is added separately. */
export const CORE_TOOLS = ["file", "agent", "steps", "timer", "archive"] as const;
/**
 * Every child, lean and read-only ones included, can run commands (`read-only-role.ts` still refuses a read-only role's
 * mutations). Not in `CORE_TOOLS`: a profile may replace `bash` with another shell tool such as `powershell`.
 */
export const SHELL_TOOLS = ["bash"] as const;
/** What a lean child keeps besides its own list: commands, the means to message its parent, track steps and wait. */
export const LEAN_FLOOR = [...SHELL_TOOLS, "agent", "steps", "timer"] as const;
/**
 * Tools every child gets by default, unlike `CORE_TOOLS` a profile may remove them (`excludeTools` or a `-` entry):
 * `skill` loads a listed skill by name, and stays out of requests while the child has none.
 */
export const DEFAULT_CHILD_TOOLS = ["skill"] as const;
/** `mcp` restarts the child's own MCP servers. */
export const MCP_ACCESS_TOOLS = ["mcp"] as const;

/**
 * The MCP tools an allowlist gains. One naming tools of the Octocode server itself curates that catalog on purpose and
 * keeps only the local reader and search (the browser role leaves out structure, AST and LSP); one naming other servers'
 * tools keeps all local research; one naming no MCP tool keeps every server (`mcp__*`).
 */
export function mcpFloor(selected: readonly string[] | undefined): readonly string[] {
	if (selected?.some(isOctocodeTool))
		return ["localFetch", "localSearch"].map((name) => `${OCTOCODE_TOOL_PREFIX}${name}`);
	return selected?.some(isMcpToolName) ? LOCAL_RESEARCH_TOOLS : ["mcp__*"];
}
