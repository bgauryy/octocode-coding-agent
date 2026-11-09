/** The MCP server name Octocode registers its built-in browser under (and looks for in `mcp.json`). */
export const BROWSER_SERVER = "browser";

/** The base prompt section that describes every enabled MCP server, one block per server (`mcp/src/section.ts`). */
export const MCPS_SECTION = "mcps";

/** The volatile prompt section that names MCP servers which are not ready (`mcp/src/section.ts`). */
export const MCP_STATUS_SECTION = "mcp_status";

/** The npm package that runs the browser server. */
export const BROWSER_PACKAGE = "@octocodeai/octocode-chrome-devtools";

/** The executable name the package's `bin` declares. */
export const BROWSER_BIN = "octocode-chrome-devtools";

const PLUGIN_SERVER_NAME = /^plugin:[A-Za-z0-9_.-]+:[A-Za-z0-9_-]+$/;

/** Whether `name` is a plugin-provided MCP server (`plugin:<plugin>:<server>`). */
export const isPluginMcpServerName = (name: string): boolean => PLUGIN_SERVER_NAME.test(name);

/** Namespace of a server's tools: `mcp__<server>` with `-` replaced by `_`, like the tool names. */
export function mcpNamespace(server: string): string {
	if (isPluginMcpServerName(server)) return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}`;
	return `mcp__${server.replace(/-/g, "_")}`;
}

/**
 * Regular expression for a tool name pattern where `*` matches any characters, as `toolExposure`,
 * `--tools`, and `--exclude-tools` accept them.
 */
function toolPatternRegExp(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`);
}

/** Whether a tool name matches any of the entries, each an exact name or a pattern. */
export function createToolNameMatcher(entries: readonly string[]): (name: string) => boolean {
	const names = new Set(entries.filter((entry) => !entry.includes("*")));
	const patterns = entries.filter((entry) => entry.includes("*")).map(toolPatternRegExp);
	return (name) => names.has(name) || patterns.some((pattern) => pattern.test(name));
}

/** The built-in MCP extension's tool that lists, connects and edits servers. */
export const MCP_MANAGE_TOOL_NAME = "mcp";

export const isMcpToolName = (name: string): boolean => name.startsWith("mcp__");
