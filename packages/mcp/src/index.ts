/**
 * Registers configured MCP servers and their native tools. Servers the session's tool selection reaches are started,
 * and those with declared tools are awaited before the first prompt.
 */

import type { McpExtensionApi, McpExtensionFactory } from "./host/types.ts";
import { registerMcpCommand } from "./command.ts";
import { registerSessionEvents } from "./events.ts";
import { registerMcpManageTool } from "./manage-tool-wiring.ts";
import { registerAcpClientMcpServers } from "./acp-session-servers.ts";
import { registerInheritedMcpServers } from "./session-servers.ts";
import { McpExtensionState, type McpExtensionOptions } from "./state.ts";
import { createMcpToolRenderers } from "./tool-definition.ts";
import { mcpToolStates, publishMcpToolStates } from "./tool-states.ts";

export type { McpTransportFactory } from "./runtime.ts";
export type { McpExtensionOptions } from "./state.ts";
export { currentToolRoles, resolveToolRoles, roleOf, type ResolvedRoles, type RoleEntry } from "./roles.ts";
export type { McpInstallConfig, McpToolRolesConfig } from "@octocodeai/octocode-contracts/mcp-server";

export function createMcpExtension(options: McpExtensionOptions = {}): McpExtensionFactory {
	return (api: McpExtensionApi) => {
		registerMcpHost(api, options);
	};
}

export function registerMcpHost(api: McpExtensionApi, options: McpExtensionOptions = {}): McpExtensionState {
	const state = new McpExtensionState(api, options);
	const inherited = registerInheritedMcpServers(api);
	state.parentStopped = new Set(inherited.stopped);
	state.taskServers = inherited.only ? new Set(inherited.only) : undefined;
	state.taskNamed = inherited.only ? new Set(inherited.named) : undefined;
	registerAcpClientMcpServers(api);

	// A resumed session renders calls to MCP tools before their server connected, if it ever does.
	api.registerToolRenderer((toolName, next) => {
		const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
		return next() ?? (match ? createMcpToolRenderers(`${match[1]}/${match[2]}`) : undefined);
	});

	// Session events, then the model's `mcp` tool, then the `/mcp` command, in registration order.
	registerSessionEvents(state);
	registerMcpManageTool(state);
	registerMcpCommand(state);
	// What a settings view shows of each tool; read on request, never on a session event.
	publishMcpToolStates(
		() => mcpToolStates(state),
		() =>
			state.session.signal.aborted
				? undefined
				: [
						...new Set([
							...state.servers.map((server) => server.entry.name),
							...api.getMcpServers().map((server) => server.name),
						]),
					],
	);
	return state;
}
