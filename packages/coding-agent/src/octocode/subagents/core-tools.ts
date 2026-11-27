import { currentToolRoles } from "../../../../mcp/src/api.ts";
import { ROLE_VARIANT_ORDER } from "../../core/tool-roles.ts";
import { isMcpToolName } from "@octocodeai/octocode-common/mcp-names";

/** Every child can save files, communicate, ask for notices with timers, recover history and read memories; local research is added separately. */
export const CORE_TOOLS = ["file", "agent", "notify", "archive", "memory"] as const;
/**
 * Every child, lean and read-only ones included, can run commands (`read-only-role.ts` still refuses a read-only role's
 * mutations). Not in `CORE_TOOLS`: a profile may replace `bash` with another shell tool such as `powershell`.
 */
export const SHELL_TOOLS = ["bash"] as const;
/**
 * What a lean child keeps besides its own list: commands and the means to message its parent. No `notify`: a lean task is
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
 * The local research tools: every MCP tool the session's servers mark as a reader, a search or a judge (`roles` in a
 * server entry, `mcp/src/roles.ts`), never a tool picked by name. Empty while no server has roles.
 */
export function localResearchTools(): readonly string[] {
	const { readers, searches, judges } = currentToolRoles();
	return [...readers, ...searches, ...judges];
}

/** The keys of the role-dependent native tools in an in-use set (`native/<name>`, as `native-deferral.ts` records them). */
const ROLE_VARIANT_NATIVE_KEYS: ReadonlySet<string> = new Set(ROLE_VARIANT_ORDER.map((name) => `native/${name}`));

/**
 * The in-use set a child takes from its coordinator (`mcpExposure` `usage` or `recent`): the coordinator's, so both
 * declare the shared tool prefix alike, without the native tools whose declaration depends on the role (`memory`,
 * `archive`, `models`, `backlogPlan`). Those follow the shared prefix, and a child calls them in a few percent of its
 * runs where its coordinator calls them in most, so the child declares them deferred or leaves them on demand.
 */
export function childInUseTools(recent: readonly string[]): string[] {
	return recent.filter((key) => !ROLE_VARIANT_NATIVE_KEYS.has(key));
}

/**
 * The MCP tools an allowlist gains. One naming tools of the research server (the one with a reader and a search role)
 * curates that catalog on purpose and keeps only its reader and its first search; one naming other servers' tools keeps
 * all local research; one naming no MCP tool keeps every server (`mcp__*`). Never a tool the configuration leaves on
 * demand: an exact name in an allowlist declares it (`tool-loadout/activation.ts`), which would undo that exposure.
 */
export function mcpFloor(selected: readonly string[] | undefined): readonly string[] {
	const { research, onDemand } = currentToolRoles();
	const declared = (tools: readonly string[]) => tools.filter((tool) => !onDemand.has(tool));
	if (research && selected?.some((name) => name.startsWith(research.prefix)))
		return declared([research.reader, research.search[0]]);
	return selected?.some(isMcpToolName) ? declared(localResearchTools()) : ["mcp__*"];
}
