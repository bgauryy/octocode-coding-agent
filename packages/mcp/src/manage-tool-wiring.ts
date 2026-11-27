/** Connects the model's `mcp` tool to this session's servers. */

import { readServerResource, resourceListing } from "./catalog-requests.ts";
import { reconnect } from "./connections.ts";
import { toToolResult } from "./tool-result.ts";
import { instructionsInPrompt, serverInstructions, toolCatalog } from "./inspection.ts";
import { mcpServerGroup, mcpServerSource } from "./group.ts";
import { createMcpManageTool, type ManagedMcpServer, NATIVE_SERVER } from "./manage-tool.ts";
import { describeState, isEnabled } from "./server.ts";
import { registerMcpAddedServers } from "./session-servers.ts";
import type { McpFeatureState } from "./state.ts";
import { hideTools, loadOnDemand } from "./tool-registry.ts";

// The model's `mcp` tool lists, inspects, restarts and stops this session's servers; configuration files stay unchanged.
export function registerMcpManageTool(state: McpFeatureState): void {
	const { api } = state;
	// Children inherit enabled feature registrations, including session additions, and the names of servers stopped
	// for this session (they skip those unless their own tool selection names the server; see `session-servers.ts`).
	registerMcpAddedServers(api.channels, () => ({
		servers: Object.fromEntries(
			state.servers
				.filter(
					(server) =>
						server.entry.scope === "feature" && server.entry.config.enabled !== false && !server.connection?.isStopped,
				)
				.map((server) => [server.entry.name, server.entry.config]),
		),
		stopped: state.servers.filter((server) => server.connection?.isStopped).map((server) => server.entry.name),
		available: state.servers.filter(isEnabled).map((server) => server.entry.name),
		...(state.recentTools() ? { recent: [...(state.recentTools() ?? [])].sort() } : {}),
	}));
	// Inactive on registration: the default tool selection includes it (`core/native-tools.ts`), so `noTools` and `--tools` apply.
	api.tools.register({
		defaultActive: false,
		...createMcpManageTool({
			tools: (name) => toolCatalog(state, name),
			loaded: (server, tool) => {
				state.recordToolLoaded(server ?? NATIVE_SERVER, tool);
				if (server === undefined) state.options.nativeTools?.loaded?.(tool);
				else loadOnDemand(state, server, tool);
			},
			...(state.options.nativeTools ? { nativeTools: state.options.nativeTools } : {}),
			instructions: (name) => serverInstructions(state, name),
			instructionsInPrompt: (name) => instructionsInPrompt(state, name),
			resources: (name, signal) => resourceListing(state, name, signal),
			read: async (name, uri, signal) =>
				toToolResult(`resource ${uri}`, { content: await readServerResource(state, name, uri, signal) }, false),
			servers: (): ManagedMcpServer[] =>
				state.servers.map((server) => ({
					name: server.entry.name,
					state: server.connection?.isStopped ? "stopped" : describeState(server, false),
					connected: server.connection?.state === "connected",
					...(server.connection?.error ? { error: server.connection.error } : {}),
					group: mcpServerGroup(server.entry),
					...(server.entry.config.description ? { description: server.entry.config.description } : {}),
					source: mcpServerSource(server.entry),
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
		}),
	});
}
