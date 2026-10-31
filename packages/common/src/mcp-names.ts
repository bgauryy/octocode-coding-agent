/** The MCP server name Octocode registers its built-in browser under (and looks for in `mcp.json`). */
export const BROWSER_SERVER = "browser";

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
