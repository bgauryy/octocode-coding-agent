/** Connects the model's `mcp` tool to this session's servers. */

import type { McpServerConfig } from "../../core/mcp-servers.ts";
import { reconnect } from "./connections.ts";
import { toolCatalog } from "./inspection.ts";
import { createMcpManageTool, type ManagedMcpServer } from "./manage-tool.ts";
import { describeState } from "./server.ts";
import { registerMcpAddedServers } from "./session-servers.ts";
import type { McpExtensionState } from "./state.ts";
import { getMcpReconnect, getMcpSessionStatus } from "./status.ts";
import { ensureDiscoveryActive, hideTools } from "./tool-registry.ts";

// The model's `mcp` tool acts on this session's servers only; configuration files stay unchanged.
export function registerMcpManageTool(state: McpExtensionState): void {
	const { pi } = state;
	/** Servers the `mcp` tool added for this session; only these can be removed through it. */
	const addedHere = new Map<string, McpServerConfig>();
	// Subagents started later inherit the added servers that still run (`session-servers.ts`); a stopped one stays out.
	registerMcpAddedServers(pi.events, () =>
		Object.fromEntries([...addedHere].filter(([name]) => !state.findServer(name)?.connection?.isStopped)),
	);
	// Inactive on registration: the default tool selection includes it (`core/native-tools.ts`), so `noTools` and `--tools` apply.
	pi.registerTool({
		defaultActive: false,
		...createMcpManageTool({
			tools: (name) => toolCatalog(state, name),
			servers: (): ManagedMcpServer[] => [
				...state.servers.map((server) => ({
					name: server.entry.name,
					state: server.connection?.isStopped ? "stopped" : describeState(server, false),
					connected: server.connection?.state === "connected",
					origin: addedHere.has(server.entry.name) ? ("added" as const) : ("configured" as const),
					...(server.connection?.error ? { error: server.connection.error } : {}),
				})),
				...getMcpSessionStatus(pi.events)
					.filter((status) => !state.findServer(status.name))
					.map((status) => ({
						name: status.name,
						state: `${status.state} · ${status.toolCount} tools`,
						connected: status.state === "connected",
						origin: "automatic" as const,
					})),
			],
			restart: async (name, ctx) => {
				const server = state.findServer(name);
				if (!server) {
					const owner = getMcpReconnect(pi.events, name);
					return owner ? owner(ctx) : `MCP server "${name}" cannot be restarted here.`;
				}
				if (!server.connection)
					return `MCP server "${name}" is disabled in its configuration; the user can enable it with /mcp enable ${name}.`;
				const failure = await reconnect(server);
				ensureDiscoveryActive(state, ctx);
				return failure;
			},
			stop: async (name) => {
				const connection = state.findServer(name)?.connection;
				if (!connection)
					return `MCP server "${name}" runs outside this extension; restart it instead, or ask the user to disable it.`;
				await connection.stop();
				hideTools(state, name);
				state.emitChange();
				return undefined;
			},
			add: (name, config) => {
				addedHere.set(name, config);
				pi.registerMcpServer(name, config);
			},
			remove: async (name) => {
				if (!addedHere.has(name))
					return `MCP server "${name}" comes from configuration; stop it for this session instead.`;
				addedHere.delete(name);
				pi.unregisterMcpServer(name);
				return undefined;
			},
		}),
	});
}
