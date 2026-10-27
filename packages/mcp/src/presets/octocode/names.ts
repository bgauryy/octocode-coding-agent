import { mcpNamespace } from "../../servers.ts";
/** The MCP server name Octocode registers its research server under (and looks for in `mcp.json`). */
export const OCTOCODE_SERVER = "octocode";

/**
 * Local reader and search names, including older aliases, used for research roles and routing. The legacy
 * DIRECT_TOOLS name is retained; exposure of the full catalog follows the shared MCP defaults and configuration.
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

/**
 * Research tools that few sessions use and whose schemas are large: the preset defers them behind `tool_search` unless the
 * user's `mcp.json` sets the server's `exposure` or the tool's `toolExposure`. The local readers and searches, and the
 * GitHub file and code readers, stay declared.
 */
export const OCTOCODE_DEFERRED_TOOLS: readonly string[] = [
	"ghSearchHistory",
	"ghGetHistoryItem",
	"clasify",
	"artifactSearch",
	"ghSearchRepo",
];

/** Whether a tool belongs to the local reader/search group, regardless of its configured exposure. */
export const isOctocodeDirectTool = (toolName: string): boolean => OCTOCODE_DIRECT_TOOLS.includes(toolName);

/** Octocode's tools are the ones of the server `OCTOCODE_SERVER`. */
export const OCTOCODE_TOOL_PREFIX = `${mcpNamespace(OCTOCODE_SERVER)}__`;

/** Whether `name` is an Octocode MCP tool. */
export const isOctocodeTool = (name: string): boolean => name.startsWith(OCTOCODE_TOOL_PREFIX);

/**
 * Local research names in the current server and the supported legacy catalog, including binary inspection.
 */
export const LOCAL_RESEARCH_TOOLS = [...OCTOCODE_DIRECT_TOOLS, "localBinaryInspect"].map(
	(name) => `${OCTOCODE_TOOL_PREFIX}${name}`,
);

/** Legacy helper for the local reader/search group; it does not resolve exposure. */
export const isDirectResearchTool = (name: string): boolean =>
	isOctocodeTool(name) && isOctocodeDirectTool(name.slice(OCTOCODE_TOOL_PREFIX.length));

export const LOCAL_READ_TOOLS = new Set(
	["localFetch", "localGetFileContent"].map((name) => `${OCTOCODE_TOOL_PREFIX}${name}`),
);
export const isOctocodeReader = (name: string): boolean => LOCAL_READ_TOOLS.has(name);
export const isOctocodeSearch = (name: string): boolean => isDirectResearchTool(name) && !isOctocodeReader(name);
