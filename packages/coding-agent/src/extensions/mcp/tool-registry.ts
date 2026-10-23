/** Registers each server's tools and the resource tools, and hides them when servers go away. */

import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { mcpNamespace } from "../../core/mcp-servers.ts";
import { TOOL_SEARCH_TOOL_NAME } from "../tool-search/tool.ts";
import { getMcpToolExposure } from "./config.ts";
import { configuredExposures, exposureOf, prefersDeferred, resolveMcpExposure } from "./exposure.ts";
import { createMcpResourceToolDefinitions } from "./resources.ts";
import type { McpServerConnection } from "./runtime.ts";
import { isEnabled, type McpServer } from "./server.ts";
import type { McpExtensionState } from "./state.ts";
import { createMcpToolDefinition, createMcpToolName } from "./tools.ts";

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
	const automaticExposure = resolveMcpExposure(
		"auto",
		state.automaticCatalog(),
		state.selectedModel,
		pi.getAllTools().some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME && tool.reachesTools),
		prefersDeferred(server, entry.config),
	);
	const resolvedExposure = (tool: string) => {
		const requested = getMcpToolExposure(entry.config, tool, server);
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
		const definition = createMcpToolDefinition({
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
					getMcpToolExposure(current.entry.config, tool.name, server) === "hidden" ||
					(client.state === "connected" && !client.tools.some((offered) => offered.name === tool.name))
				) {
					throw new Error(`MCP tool "${server}/${tool.name}" is no longer available.`);
				}
				return client;
			},
			readableResources: () => resourceServers(state).some((current) => current.name === server),
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
		const active = pi.getActiveTools();
		if (
			!active.includes(TOOL_SEARCH_TOOL_NAME) &&
			pi.getAllTools().some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME && tool.reachesTools)
		)
			pi.setActiveTools([...active, TOOL_SEARCH_TOOL_NAME]);
	}
	syncResourceTools(state);
}

/** Make a disabled server's tools unreachable. */
export function hideTools(state: McpExtensionState, server: string): void {
	for (const name of state.serverTools.get(server) ?? []) {
		const definition = state.definitions.get(name);
		if (definition && definition.exposure !== "hidden") {
			const hidden = { ...definition, exposure: "hidden" as const };
			state.definitions.set(name, hidden);
			state.pi.registerTool(hidden);
		}
	}
	state.serverTools.set(server, new Set());
	syncResourceTools(state);
}

/** Enabled servers with resources whose exposure is not `hidden`, which the resource tools reach. */
function serversWithResources(state: McpExtensionState): McpServer[] {
	return state.servers.filter(
		(server) => server.connection?.hasResources && isEnabled(server) && exposureOf(server.entry) !== "hidden",
	);
}

function resourceServers(state: McpExtensionState): McpServerConnection[] {
	return serversWithResources(state).flatMap((server) => (server.connection ? [server.connection] : []));
}

/**
 * Register the resource tools with the widest exposure of the servers they reach: `direct` when
 * one of them is direct, and so on. They are hidden when no server has resources.
 */
export function syncResourceTools(state: McpExtensionState): void {
	const exposures = new Set(serversWithResources(state).map((server) => state.effectiveExposure(server.entry)));
	const exposure = (["direct", "deferred"] as const).find((candidate) => exposures.has(candidate));
	const next = exposure ?? "hidden";
	const previous = state.resourceToolsExposure;
	if (next === previous || (previous === undefined && next === "hidden")) return;
	const wasDirect = previous === "direct";
	state.resourceToolsExposure = next;
	const resourceDefinitions = createMcpResourceToolDefinitions({
		exposure: next,
		servers: () => resourceServers(state),
	});
	for (const definition of resourceDefinitions) state.pi.registerTool(definition);
	if (wasDirect) {
		const names = new Set(resourceDefinitions.map((definition) => definition.name));
		state.pi.setActiveTools(state.pi.getActiveTools().filter((name) => !names.has(name)));
	}
}

/** Activate discovery only for deferred catalogs. */
export function ensureDiscoveryActive(state: McpExtensionState, ctx: ExtensionContext): void {
	const { pi } = state;
	const hasSearch = pi.getAllTools().some((tool) => tool.name === TOOL_SEARCH_TOOL_NAME && tool.reachesTools);
	const needsSearch = state.servers.some(
		(server) =>
			isEnabled(server) &&
			[...configuredExposures(server.entry)].some(
				(exposure) =>
					resolveMcpExposure(
						exposure,
						state.automaticCatalog(),
						state.selectedModel,
						hasSearch,
						prefersDeferred(server.entry.name, server.entry.config),
					) === "deferred",
			),
	);
	if (!needsSearch) return;
	if (hasSearch) {
		const active = pi.getActiveTools();
		if (!active.includes(TOOL_SEARCH_TOOL_NAME)) pi.setActiveTools([...active, TOOL_SEARCH_TOOL_NAME]);
		if (pi.getActiveTools().includes(TOOL_SEARCH_TOOL_NAME)) return;
	}
	if (state.warnedUnreachable) return;
	state.warnedUnreachable = true;
	ctx.ui.notify(
		"Deferred MCP tools need tool_search. Enable it or select direct exposure for these servers.",
		"warning",
	);
}
