/** Registers server tools and hides them when their server goes away. */

import { isDeepStrictEqual } from "node:util";
import { mcpNamespace } from "./servers.ts";
import { isDefaultActive, isSelected } from "./exposure.ts";
import type { McpServerConnection } from "./runtime.ts";
import { isEnabled } from "./server.ts";
import type { McpExtensionState } from "./state.ts";
import { createMcpToolDefinition } from "./tool-definition.ts";
import { assignMcpToolNames, createMcpToolName } from "./tool-names.ts";

type ToolDefinitions = Array<Parameters<McpExtensionState["definitions"]["set"]>[1]>;

/** One registry refresh for the whole batch; a host without `registerTools` gets one `registerTool` per definition. */
function registerAll(api: McpExtensionState["api"], definitions: ToolDefinitions): void {
	if (definitions.length === 0) return;
	if (typeof api.registerTools === "function") api.registerTools(definitions);
	else for (const definition of definitions) api.registerTool(definition);
}

export function registerTools(state: McpExtensionState, connection: McpServerConnection): void {
	const { api, toolOwners, serverTools, definitions, registeredMetadata, cachedDefinitions } = state;
	const server = connection.entry.name;
	const entry = state.findServer(server)?.entry ?? connection.entry;
	const description = entry.config.description?.trim();
	const namespace = {
		name: mcpNamespace(server),
		...(description ? { description } : {}),
		...(connection.instructions ? { instructions: connection.instructions } : {}),
	};
	// Off by default only where a selection names the server; a server started by hand outside the selection
	// (`/mcp` enable) was chosen for this session, so its tools activate like any other. One a hook started stays
	// unselected.
	const defaultActive = isDefaultActive(entry) || (!state.findServer(server)?.unselected && !isSelected(api, entry));
	const previous = serverTools.get(server) ?? new Set<string>();
	const current = new Set<string>();
	const owner = (tool: string) => `${server}\0${tool}`;
	const names = assignMcpToolNames(
		server,
		connection.tools.map((tool) => tool.name),
		(candidate, tool) => {
			const existing = toolOwners.get(candidate);
			return existing !== undefined && existing !== owner(tool);
		},
	);
	// The server's generated file follows its catalog and configuration: a connect, `tools/list_changed`, new
	// instructions or a tool hidden in `mcp.json` each arrive here, and a changed catalog hash renders a new file.
	// The file names each tool by the name assigned here, which is the name the model calls.
	const { presentation } = state;
	presentation.sync(
		server,
		mcpNamespace(server).slice("mcp__".length),
		connection.instructions,
		connection.tools.filter((tool) => state.toolExposure(entry, tool.name) !== "hidden"),
		names,
	);
	const batch: ToolDefinitions = [];
	const demoted: string[] = [];
	for (const tool of connection.tools) {
		const name = names.get(tool.name) ?? createMcpToolName(server, tool.name);
		toolOwners.set(name, owner(tool.name));
		current.add(name);
		const exposure = state.toolExposure(entry, tool.name);
		const thin = presentation.isThin(server, tool);
		// A thin declaration depends on the tool's own block of the generated file, not on the rest of the catalog.
		const metadata = {
			tool,
			namespace,
			exposure,
			defaultActive,
			timeoutMs: connection.timeoutMs,
			compact: thin ? presentation.signature(server, tool.name) : null,
			summary: thin ? presentation.summary(server, tool.name) : null,
		};
		const cached = isDeepStrictEqual(registeredMetadata.get(name), metadata) ? cachedDefinitions.get(name) : undefined;
		if (cached) {
			if (definitions.get(name) !== cached) {
				definitions.set(name, cached);
				batch.push(cached);
			}
			continue;
		}
		const wasDirect = definitions.get(name)?.exposure === "direct";
		const definition = (state.preset(entry)?.defineTool ?? createMcpToolDefinition)({
			server,
			tool,
			name,
			exposure,
			defaultActive,
			namespace,
			timeoutMs: connection.timeoutMs,
			...(thin
				? {
						compact: {
							signature: () => presentation.signature(server, tool.name),
							...(metadata.summary ? { summary: metadata.summary } : {}),
						},
					}
				: {}),
			getClient: async () => {
				// A prepared call can outlive this definition's connection while the readiness
				// hook waits for a disable/re-enable. Resolve the replacement at execution time.
				const current = state.findServer(server);
				if (!current || !isEnabled(current)) throw new Error(`MCP server "${server}" is disabled.`);
				const client = current.connection;
				if (!client) throw new Error(`MCP server "${server}" is still starting.`);
				if (
					state.toolExposure(current.entry, tool.name) === "hidden" ||
					(client.state === "connected" && !client.tools.some((offered) => offered.name === tool.name))
				) {
					throw new Error(`MCP tool "${server}/${tool.name}" is no longer available.`);
				}
				return client;
			},
		});
		registeredMetadata.set(name, structuredClone(metadata));
		cachedDefinitions.set(name, definition);
		definitions.set(definition.name, definition);
		batch.push(definition);
		if (wasDirect && exposure !== "direct") demoted.push(name);
	}
	serverTools.set(server, current);
	// Tools cannot be unregistered, so tools the server dropped are re-registered as hidden. When
	// the server offers them again they are registered with their configured exposure above.
	for (const name of previous) {
		const definition = definitions.get(name);
		if (!current.has(name) && definition) {
			const hidden = { ...definition, exposure: "hidden" as const };
			definitions.set(name, hidden);
			batch.push(hidden);
		}
	}
	registerAll(api, batch);
	if (demoted.length > 0) api.setActiveTools(api.getActiveTools().filter((active) => !demoted.includes(active)));
}

/** Make a disabled server's tools unreachable. */
export function hideTools(state: McpExtensionState, server: string): void {
	state.presentation.forget(server);
	const batch: ToolDefinitions = [];
	for (const name of state.serverTools.get(server) ?? []) {
		const definition = state.definitions.get(name);
		if (definition && definition.exposure !== "hidden") {
			const hidden = { ...definition, exposure: "hidden" as const };
			state.definitions.set(name, hidden);
			batch.push(hidden);
		}
	}
	registerAll(state.api, batch);
	state.serverTools.set(server, new Set());
}
