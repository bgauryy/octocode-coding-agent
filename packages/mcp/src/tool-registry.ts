/** Registers server tools and hides them when their server goes away. */

import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "../../coding-agent/src/core/extensions/types.ts";
import { mcpNamespace } from "./servers.ts";
import {
	activateDiscovery,
	canDiscoverTools,
	TOOL_SEARCH_TOOL_NAME,
} from "../../coding-agent/src/core/tools/tool-search.ts";
import { configuredExposures } from "./exposure.ts";
import type { McpServerConnection } from "./runtime.ts";
import { isEnabled } from "./server.ts";
import type { McpExtensionState } from "./state.ts";
import { createMcpToolDefinition } from "./tool-definition.ts";
import { createMcpToolName } from "./tools.ts";

export function registerTools(state: McpExtensionState, connection: McpServerConnection): void {
	const { pi, toolOwners, serverTools, definitions, registeredMetadata, cachedDefinitions } = state;
	const server = connection.entry.name;
	const entry = state.findServer(server)?.entry ?? connection.entry;
	const description = entry.config.description?.trim();
	const namespace = {
		name: mcpNamespace(server),
		// Discovery accepts the configured server name as well as its MCP namespace.
		aliases: [server],
		...(description ? { description } : {}),
		...(connection.instructions ? { instructions: connection.instructions } : {}),
	};
	const automaticExposure = state.automaticExposure(entry);
	const resolvedExposure = (tool: string) => {
		const requested = state.toolExposure(entry, tool);
		return requested === "auto" ? automaticExposure : requested;
	};
	const previous = serverTools.get(server) ?? new Set<string>();
	const current = new Set<string>();
	// Like Codex, all tools whose names sanitize to the same name get the hash suffix, so which
	// one would keep the plain name does not depend on the order of the list.
	const plain = [...new Set(connection.tools.map((tool) => tool.name))].map((tool) => createMcpToolName(server, tool));
	const assignName = (tool: string, owner: string) => {
		const name = createMcpToolName(server, tool, (candidate) => {
			const existing = toolOwners.get(candidate);
			return (
				(existing !== undefined && existing !== owner) ||
				current.has(candidate) ||
				plain.indexOf(candidate) !== plain.lastIndexOf(candidate)
			);
		});
		toolOwners.set(name, owner);
		current.add(name);
		return name;
	};
	for (const tool of connection.tools) {
		const name = assignName(tool.name, `${server}\0${tool.name}`);
		const exposure = resolvedExposure(tool.name);
		const metadata = { tool, namespace, exposure, timeoutMs: connection.timeoutMs };
		const cached = isDeepStrictEqual(registeredMetadata.get(name), metadata) ? cachedDefinitions.get(name) : undefined;
		if (cached) {
			if (definitions.get(name) !== cached) {
				definitions.set(name, cached);
				pi.registerTool(cached);
			}
			continue;
		}
		const wasDirect = definitions.get(name)?.exposure === "direct";
		const definition = (state.preset(entry)?.defineTool ?? createMcpToolDefinition)({
			server,
			tool,
			name,
			exposure,
			namespace,
			timeoutMs: connection.timeoutMs,
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
		pi.registerTool(definition);
		if (wasDirect && exposure !== "direct") pi.setActiveTools(pi.getActiveTools().filter((active) => active !== name));
	}
	serverTools.set(server, current);
	// Tools cannot be unregistered, so tools the server dropped are re-registered as hidden. When
	// the server offers them again they are registered with their configured exposure above.
	for (const name of previous) {
		const definition = definitions.get(name);
		if (!current.has(name) && definition) {
			const hidden = { ...definition, exposure: "hidden" as const };
			definitions.set(name, hidden);
			pi.registerTool(hidden);
		}
	}
	if (connection.tools.some((tool) => resolvedExposure(tool.name) === "deferred")) {
		activateDiscovery(pi);
	}
}

/** Make a disabled server's tools unreachable. */
export function hideTools(state: McpExtensionState, server: string): void {
	state.resetAutomaticExposure(server);
	for (const name of state.serverTools.get(server) ?? []) {
		const definition = state.definitions.get(name);
		if (definition && definition.exposure !== "hidden") {
			const hidden = { ...definition, exposure: "hidden" as const };
			state.definitions.set(name, hidden);
			state.pi.registerTool(hidden);
		}
	}
	state.serverTools.set(server, new Set());
}

/** Activate discovery only for deferred catalogs. */
export function ensureDiscoveryActive(state: McpExtensionState, ctx: ExtensionContext): void {
	const { pi } = state;
	const hasSearch = canDiscoverTools(pi);
	const needsSearch = state.servers.some(
		(server) =>
			isEnabled(server) &&
			[...configuredExposures(server.entry)].some(
				(exposure) => (exposure === "auto" ? state.automaticExposure(server.entry) : exposure) === "deferred",
			),
	);
	if (!needsSearch) return;
	if (hasSearch) {
		// A deselection after tool_search was active stands (see `activateDiscovery`): warn instead of re-adding it.
		activateDiscovery(pi);
		if (pi.getActiveTools().includes(TOOL_SEARCH_TOOL_NAME)) return;
	}
	if (state.warnedUnreachable) return;
	state.warnedUnreachable = true;
	ctx.ui.notify(
		"Deferred MCP tools need tool_search. Enable it or select direct exposure for these servers.",
		"warning",
	);
}
