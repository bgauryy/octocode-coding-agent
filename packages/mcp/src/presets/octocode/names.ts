import { mcpNamespace } from "../../../../common/src/mcp-names.ts";
/** The MCP server name Octocode registers its research server under (and looks for in `mcp.json`). */
export const OCTOCODE_SERVER = "octocode";

/**
 * Local reader and search names, including older aliases, used for research roles and routing. The legacy
 * DIRECT_TOOLS name is retained; exposure of the full catalog follows the shared MCP defaults and configuration.
 */
const OCTOCODE_DIRECT_TOOLS: readonly string[] = [
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

/** Whether a tool belongs to the local reader/search group, regardless of its configured exposure. */
const isOctocodeDirectTool = (toolName: string): boolean => OCTOCODE_DIRECT_TOOLS.includes(toolName);

/** Octocode's tools are the ones of the server `OCTOCODE_SERVER`. */
export const OCTOCODE_TOOL_PREFIX = `${mcpNamespace(OCTOCODE_SERVER)}__`;

/** Whether `name` is an Octocode MCP tool. */
export const isOctocodeTool = (name: string): boolean => name.startsWith(OCTOCODE_TOOL_PREFIX);

/**
 * The first Octocode line of the policy's `research.md`. The base prompt leaves its own bash search rule out while a
 * session's sections carry it, so only one of the two shows, whether or not the server's tools are declared yet.
 */
const OCTOCODE_SEARCH_RULE = `Use Octocode MCP (\`${OCTOCODE_TOOL_PREFIX}*\`) to check code before you rely on it`;

/** Whether these prompt sections route code search to Octocode MCP. */
export const routesSearchToOctocode = (sections: Record<string, string | undefined>): boolean =>
	sections.research?.includes(OCTOCODE_SEARCH_RULE) === true;

/**
 * Local research names in the current server and the supported legacy catalog, including binary inspection.
 */
export const LOCAL_RESEARCH_TOOLS = [...OCTOCODE_DIRECT_TOOLS, "localBinaryInspect"].map(
	(name) => `${OCTOCODE_TOOL_PREFIX}${name}`,
);

/** Legacy helper for the local reader/search group; it does not resolve exposure. */
const isDirectResearchTool = (name: string): boolean =>
	isOctocodeTool(name) && isOctocodeDirectTool(name.slice(OCTOCODE_TOOL_PREFIX.length));

export const LOCAL_READ_TOOLS = new Set(
	["localFetch", "localGetFileContent"].map((name) => `${OCTOCODE_TOOL_PREFIX}${name}`),
);
export const isOctocodeReader = (name: string): boolean => LOCAL_READ_TOOLS.has(name);
export const isOctocodeSearch = (name: string): boolean => isDirectResearchTool(name) && !isOctocodeReader(name);
