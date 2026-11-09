/** The `mcp` subcommands: help rows and shell completion both read this. */
export const MCP_COMMANDS = [
	["add", "<server>", "Add or replace a server in mcp.json"],
	["remove", "<server>", "Remove a server from mcp.json"],
	["exposure", "<server> <mode>", "Change how its tools are reached"],
	["list", "", "Show state, tools, and errors (exits 1 on failure)"],
	["tools", "[server] [tool]", "List tools, or inspect a tool's description and input schema"],
	["compact", "<action>", "Show, check, store or list the TypeScript file the model reads for each server"],
	["config", "", "Show global/workspace paths and their read order"],
	["login", "<server>", "Sign in through the browser"],
	["logout", "<server>", "Delete the stored OAuth credentials"],
] as const;
