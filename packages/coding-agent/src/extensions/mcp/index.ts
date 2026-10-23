/**
 * Registers configured MCP servers and their native tools. Direct and automatic catalogs are
 * awaited before the first prompt; deferred discovery waits only for the servers it reaches.
 */

import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { registerMcpCommand } from "./command.ts";
import { registerSessionEvents } from "./events.ts";
import { registerMcpManageTool } from "./manage-tool-wiring.ts";
import { registerInheritedMcpServers } from "./session-servers.ts";
import { McpExtensionState, type McpExtensionOptions } from "./state.ts";
import { createMcpToolRenderers } from "./tools.ts";

export {
	MAX_SERVERS_SECTION_CHARS,
	MCP_SERVERS_SECTION,
	type McpServerListing,
	reachesServer,
	renderServersSection,
} from "./section.ts";
export type { McpTransportFactory } from "./runtime.ts";
export type { McpExtensionOptions } from "./state.ts";

export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const state = new McpExtensionState(pi, options);
		registerInheritedMcpServers(pi);

		// A resumed session renders calls to MCP tools before their server connected, if it ever does.
		pi.registerToolRenderer((toolName, next) => {
			const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
			return next() ?? (match ? createMcpToolRenderers(`${match[1]}/${match[2]}`) : undefined);
		});

		// Session events, then the model's `mcp` tool, then the `/mcp` command, in registration order.
		registerSessionEvents(state);
		registerMcpManageTool(state);
		registerMcpCommand(state);
	};
}

export default createMcpExtension();
