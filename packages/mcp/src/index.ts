/**
 * Registers configured MCP servers and their native tools. Servers the session's tool selection reaches are started,
 * and those with declared tools are awaited before the first prompt.
 */

import type { ExtensionAPI, ExtensionFactory } from "../../coding-agent/src/core/extensions/types.ts";
import { registerMcpCommand } from "./command.ts";
import { registerSessionEvents } from "./events.ts";
import { registerMcpManageTool } from "./manage-tool-wiring.ts";
import { registerInheritedMcpServers } from "./session-servers.ts";
import { McpExtensionState, type McpExtensionOptions } from "./state.ts";
import { createMcpToolRenderers } from "./tool-definition.ts";

export type { McpTransportFactory } from "./runtime.ts";
export type { McpExtensionOptions } from "./state.ts";

export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
	return (api: ExtensionAPI) => {
		registerMcpHost(api, options);
	};
}

export function registerMcpHost(api: ExtensionAPI, options: McpExtensionOptions = {}): McpExtensionState {
	const state = new McpExtensionState(api, options);
	registerInheritedMcpServers(api);

	// A resumed session renders calls to MCP tools before their server connected, if it ever does.
	api.registerToolRenderer((toolName, next) => {
		const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
		return next() ?? (match ? createMcpToolRenderers(`${match[1]}/${match[2]}`) : undefined);
	});

	// Session events, then the model's `mcp` tool, then the `/mcp` command, in registration order.
	registerSessionEvents(state);
	registerMcpManageTool(state);
	registerMcpCommand(state);
	return state;
}
