import { isOctocodeDirectTool, OCTOCODE_DIRECT_TOOLS, OCTOCODE_SERVER } from "../../core/mcp-servers.ts";

/** The MCP server name this extension registers Octocode under (and looks for in Octocode's `mcp.json`). */
export { OCTOCODE_SERVER };

/** Octocode names the tools of an MCP server it runs `mcp__<server>__<tool>`. */
const MCP_TOOL_PREFIX = "mcp__";

/** Whether `name` is a tool of some MCP server. */
export const isMcpTool = (name: string): boolean => name.startsWith(MCP_TOOL_PREFIX);

/** Octocode's tools are the ones of the server `OCTOCODE_SERVER`. */
export const OCTOCODE_TOOL_PREFIX = `${MCP_TOOL_PREFIX}${OCTOCODE_SERVER}__`;

/** Whether `name` is an Octocode MCP tool. */
export const isOctocodeTool = (name: string): boolean => name.startsWith(OCTOCODE_TOOL_PREFIX);

/**
 * Local research names in the current server and the supported legacy catalog: the ones core declares directly, plus
 * `localBinaryInspect`, which is local but waits for tool_search.
 */
export const LOCAL_RESEARCH_TOOLS = [...OCTOCODE_DIRECT_TOOLS, "localBinaryInspect"].map(
	(name) => `${OCTOCODE_TOOL_PREFIX}${name}`,
);

/** Whether an Octocode tool (full name) is declared to the model by default; the others are discovered through tool_search. */
export const isDirectResearchTool = (name: string): boolean =>
	isOctocodeTool(name) && isOctocodeDirectTool(name.slice(OCTOCODE_TOOL_PREFIX.length));
