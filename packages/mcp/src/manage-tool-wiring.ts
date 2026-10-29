/** Connects the model's `mcp` tool to this session's servers. */

import type { McpServerConfig } from "./servers.ts";
import { reconnect } from "./connections.ts";
import { toolCatalog } from "./inspection.ts";
import { createMcpManageTool, type ManagedMcpServer } from "./manage-tool.ts";
import { describeState, isEnabled } from "./server.ts";
import { registerMcpAddedServers } from "./session-servers.ts";
import type { McpExtensionState } from "./state.ts";
import { hideTools } from "./tool-registry.ts";

// The model's `mcp` tool acts on this session's servers only; configuration files stay unchanged.
export function registerMcpManageTool(state: McpExtensionState): void {
	const { pi } = state;
	/** Servers the `mcp` tool added for this session; only these can be removed through it. */
	const addedHere = new Map<string, McpServerConfig>();
	// Children inherit enabled extension registrations, including session additions; stopped servers stay out.
	registerMcpAddedServers(pi.events, () =>
		Object.fromEntries(
			state.servers
				.filter(
					(server) =>
						server.entry.scope === "extension" &&
						server.entry.config.enabled !== false &&
						!server.connection?.isStopped,
				)
				.map((server) => [server.entry.name, server.entry.config]),
		),
	);
	// Inactive on registration: the default tool selection includes it (`core/native-tools.ts`), so `noTools` and `--tools` apply.
	pi.registerTool({
		defaultActive: false,
		...createMcpManageTool({
			tools: (name) => toolCatalog(state, name),
			servers: (): ManagedMcpServer[] =>
				state.servers.map((server) => ({
					name: server.entry.name,
					state: server.connection?.isStopped ? "stopped" : describeState(server, false),
					connected: server.connection?.state === "connected",
					origin: addedHere.has(server.entry.name) ? ("added" as const) : ("configured" as const),
					...(server.connection?.error ? { error: server.connection.error } : {}),
				})),
			restart: async (name) => {
				const server = state.findServer(name);
				if (!server) return `No MCP server named "${name}".`;
				if (!isEnabled(server))
					return `MCP server "${name}" is disabled in its configuration; the user can enable it with /mcp enable ${name}.`;
				// Outside this session's tool selection: its tools belong to the agents that select them.
				if (server.unselected)
					return `MCP server "${name}" is not selected for this session; delegate to an agent whose tools include it, or the user can assign it to every agent with /mcp assign ${name} all.`;
				if (!server.connection) return `MCP server "${name}" is still starting; check its status before restarting.`;
				const failure = await reconnect(server);
				return failure;
			},
			stop: async (name) => {
				const connection = state.findServer(name)?.connection;
				if (!connection) return `MCP server "${name}" cannot be stopped here.`;
				await connection.stop();
				hideTools(state, name);
				state.emitChange();
				return undefined;
			},
			add: (name, config) => {
				pi.registerMcpServer(name, config);
				addedHere.set(name, config);
			},
			remove: async (name) => {
				if (!addedHere.has(name))
					return `MCP server "${name}" comes from configuration; stop it for this session instead.`;
				pi.unregisterMcpServer(name);
				addedHere.delete(name);
				return undefined;
			},
		}),
	});
}
