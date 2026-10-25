import { mcpNamespace } from "../../servers.ts";
/** The MCP server name Octocode registers its research server under (and looks for in `mcp.json`). */
export const OCTOCODE_SERVER = "octocode";

/**
 * Octocode research tools declared to the model whatever runs the `octocode` server: every local reader and search,
 * and the names older servers use for the same jobs. The server's GitHub and package tools wait for tool_search
 * (the preset’s `preferDeferred` policy).
 */
export const OCTOCODE_DIRECT_TOOLS: readonly string[] = [
	"localFetch",
	"localSearch",
	"structureSearch",
	"astSearch",
	"lspSearch",
	"localGetFileContent",
	"localSearchCode",
	"localFindFiles",
	"localViewStructure",
	"lspGetSemantics",
];

/** Whether an `octocode` tool is declared directly by default (the user's exposure settings still win). */
export const isOctocodeDirectTool = (toolName: string): boolean => OCTOCODE_DIRECT_TOOLS.includes(toolName);

/** Octocode's tools are the ones of the server `OCTOCODE_SERVER`. */
export const OCTOCODE_TOOL_PREFIX = `${mcpNamespace(OCTOCODE_SERVER)}__`;

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

export const LOCAL_READ_TOOLS = new Set(
	["localFetch", "localGetFileContent"].map((name) => `${OCTOCODE_TOOL_PREFIX}${name}`),
);
export const isOctocodeReader = (name: string): boolean => LOCAL_READ_TOOLS.has(name);
export const isOctocodeSearch = (name: string): boolean => isDirectResearchTool(name) && !isOctocodeReader(name);
