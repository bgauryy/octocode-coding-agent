/** Registers server tools and hides them when their server is stopped, disabled or removed, or stops offering them. */

import { isDeepStrictEqual } from "node:util";
import { mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import { declaredExposure, isDefaultActive, isSelected } from "./exposure.ts";
import type { McpServerConnection } from "./runtime.ts";
import { downAfterReconnectWait } from "./runtime/reconnect-wait.ts";
import { declaredInFull } from "./redeclare.ts";
import { isOnDemand, markOnDemandLoaded } from "./on-demand.ts";
import { isEnabled } from "./server.ts";
import type { McpFeatureState } from "./state.ts";
import { createMcpToolDefinition } from "./tool-definition.ts";
import { assignMcpToolNames, createMcpToolName } from "./tool-names.ts";

type ToolDefinitions = Array<Parameters<McpFeatureState["definitions"]["set"]>[1]>;

/** One registry refresh for the whole batch; a host without `registerTools` gets one `registerTool` per definition. */
function registerAll(api: McpFeatureState["api"], definitions: ToolDefinitions): void {
	if (definitions.length === 0) return;
	if (typeof api.tools.registerAll === "function") api.tools.registerAll(definitions);
	else for (const definition of definitions) api.tools.register(definition);
}

export function registerTools(state: McpFeatureState, connection: McpServerConnection): void {
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
	const defaultActive =
		isDefaultActive(entry, state.taskNamed) ||
		(!state.findServer(server)?.unselected && !isSelected(api, entry, state.taskNamed));
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
	// Read once: it asks the settings, which are the same for every tool of this pass.
	const declared = presentation.declared;
	for (const tool of connection.tools) {
		const name = names.get(tool.name) ?? createMcpToolName(server, tool.name);
		toolOwners.set(name, owner(tool.name));
		current.add(name);
		const exposure = declaredExposure(state.toolExposure(entry, tool.name));
		// A deferred tool the transcript already declares in full (loaded before a resume, or on this branch) stays full.
		const loaded =
			presentation.isThin(server, tool) &&
			declaredInFull(state.declaredBefore, name, tool) &&
			presentation.load(server, tool.name);
		const thin = !loaded && presentation.isThin(server, tool);
		// Undeclared until the session loads or calls it: registered inactive, and the host activates it on its first call.
		const onDemand = isOnDemand(state, entry, tool.name, name);
		// A thin declaration depends on the tool's own block of the generated file, not on the rest of the catalog.
		const metadata = {
			namespace,
			exposure,
			defaultActive,
			timeoutMs: connection.timeoutMs,
			compact: thin ? presentation.signature(server, tool.name) : null,
			// `declared`: no generated file describes a deferred tool, so its declaration keeps the server's description.
			whole: thin && declared,
			deferred: thin && presentation.isDeferred(server, tool.name),
			onDemand,
		};
		// The catalog hands out the same tool object while the server lists it unchanged (`catalog.ts`), so the tool the
		// definition was built from is compared by identity first; the deep comparison runs only for a new object.
		const registered = registeredMetadata.get(name);
		const cached =
			registered &&
			(registered.tool === tool || isDeepStrictEqual(registered.toolCopy, tool)) &&
			isDeepStrictEqual(registered.rest, metadata)
				? cachedDefinitions.get(name)
				: undefined;
		if (cached) {
			if (definitions.get(name) !== cached) {
				definitions.set(name, cached);
				batch.push(cached);
			}
			continue;
		}
		const wasDirect = definitions.get(name)?.exposure === "direct";
		const built = (state.preset(entry)?.defineTool ?? createMcpToolDefinition)({
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
							...(metadata.whole ? { whole: true } : {}),
							...(metadata.deferred ? { deferred: true } : {}),
						},
					}
				: {}),
			getClient: async (signal) => {
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
				// A dropped server keeps its tools declared; its calls fail here, after the bounded wait for a reconnect.
				const down = await downAfterReconnectWait(client, signal);
				if (down) throw down;
				state.recordToolUse(server, tool.name);
				return client;
			},
		});
		// A call a deferred tool's schema rejected is demand for its full declaration (`usage-counts.ts`).
		const definition: typeof built = {
			...built,
			...(onDemand ? { defaultActive: false, onDemand: true } : {}),
			validationHint: (failure) => {
				if (thin && presentation.isDeferred(server, tool.name)) state.recordToolRefused(server, tool.name);
				return built.validationHint?.(failure);
			},
		};
		registeredMetadata.set(name, { tool, toolCopy: structuredClone(tool), rest: structuredClone(metadata) });
		cachedDefinitions.set(name, definition);
		definitions.set(definition.name, definition);
		batch.push(definition);
		if (wasDirect && exposure !== "direct") demoted.push(name);
	}
	serverTools.set(server, current);
	// Tools cannot be unregistered, so tools the server no longer offers are re-registered as hidden. A drop or
	// a failed reconnect never gets here: the connection keeps its catalog, so the declarations stay as they were. When
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
	if (demoted.length > 0) api.tools.setActive(api.tools.getActive().filter((active) => !demoted.includes(active)));
}

/**
 * The session needs an on-demand tool that is registered undeclared (its schema was read, or it was called): declare it
 * in full from the next request, after the cached prefix. A tool declared already (deferred, or loaded) is left alone.
 */
export function loadOnDemand(state: McpFeatureState, server: string, tool: string): boolean {
	const name = [...state.toolOwners].find(([, owner]) => owner === `${server}\0${tool}`)?.[0];
	if (name === undefined || state.definitions.get(name)?.onDemand !== true) return false;
	if (!markOnDemandLoaded(state, server, tool)) return false;
	const connection = state.findServer(server)?.connection;
	if (connection?.state === "connected") registerTools(state, connection);
	const active = state.api.tools.getActive();
	if (!active.includes(name)) state.api.tools.setActive([...active, name]);
	return true;
}

/** Make a disabled server's tools unreachable. */
export function hideTools(state: McpFeatureState, server: string): void {
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
