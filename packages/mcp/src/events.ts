/** Session events: load and connect servers, declare their tools per prompt, wait for them, and shut down. */

import { isDeepStrictEqual } from "node:util";
import { presetEntries } from "./preset.ts";
import { getAgentDir } from "../../coding-agent/src/config.ts";
import type { ExtensionContext } from "../../coding-agent/src/core/extensions/types.ts";
import { type McpServerEntry, type LoadedMcpConfig, loadMcpConfig } from "./config.ts";
import { reconnect, reconnectSignedIn, startConnection, waitForDirectServers, waitForServers } from "./connections.ts";
import { registerMcpHookCaller } from "./hook-caller.ts";
import { reportProblems } from "./report.ts";
import { loadMcpRuntime } from "./runtime.lazy.ts";
import { mcpNamespace } from "./servers.ts";
import { resetDiscoveryActivation, TOOL_SEARCH_TOOL_NAME } from "../../coding-agent/src/core/tools/tool-search.ts";
import { MCP_SERVERS_SECTION, type McpServerListing, reachesServer, renderServersSection } from "./section.ts";
import { errorMessage } from "../../coding-agent/src/utils/guards.ts";
import { isEnabled, type McpServer } from "./server.ts";
import type { McpExtensionState } from "./state.ts";
import { ensureDiscoveryActive, hideTools, registerTools } from "./tool-registry.ts";

/**
 * The servers as the `mcp_servers` section lists them: this extension's servers with their registered tools once
 * connected, including presets and extension registrations. Deferred tools count only
 * while `tool_search` is active; without it nothing can load them.
 */
function serverListings(state: McpExtensionState): McpServerListing[] {
	const { pi } = state;
	const active = new Set(pi.getActiveTools());
	const discovery = active.has(TOOL_SEARCH_TOOL_NAME);
	const all = pi.getAllTools();
	const toolsOf = (names: Iterable<string>) => {
		const named = new Set(names);
		const tools = all.filter((tool) => named.has(tool.name));
		const declared = tools.filter(
			(tool) => active.has(tool.name) && tool.exposure !== "hidden" && (tool.exposure === "direct" || !discovery),
		);
		return {
			deferred: discovery
				? tools.filter((tool) => tool.exposure === "deferred").map((tool) => ({ name: tool.name }))
				: [],
			declared: declared.map((tool) => ({ name: tool.name })),
		};
	};
	const listings: McpServerListing[] = state.servers.map((server) => {
		const entry = {
			...server.entry,
			config: { ...server.entry.config, exposure: state.effectiveExposure(server.entry) },
		};
		const registered = server.connection?.state === "connected" ? state.serverTools.get(server.entry.name) : undefined;
		return {
			...server,
			entry,
			connection: {
				state: server.connection?.isStopped ? "stopped" : (server.connection?.state ?? "connecting"),
				instructions: server.connection?.instructions,
			},
			...(registered ? { tools: toolsOf(registered) } : {}),
		};
	});
	return listings;
}

function defaultLoadConfig(ctx: ExtensionContext, defaults: readonly McpServerEntry[]): LoadedMcpConfig {
	return loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), defaults });
}

export function registerSessionEvents(state: McpExtensionState): void {
	const { pi, options } = state;

	pi.on("session_start", (_event, ctx) => {
		resetDiscoveryActivation(pi);
		state.resetAutomaticExposure();
		state.selectedModel = ctx.model;
		const loaded = (options.loadConfig ?? defaultLoadConfig)(ctx, presetEntries(options.presets ?? []));
		state.configErrors = loaded.errors;
		state.projectConfig = loaded.projectConfig;
		state.globalConfig = loaded.globalConfig;
		state.projectTrusted = ctx.isProjectTrusted();
		state.warnedUnreachable = false;
		state.waitedForStartup = false;
		state.sessionCwd = ctx.cwd;
		state.modelRegistry = ctx.modelRegistry;
		state.session = new AbortController();
		const { signal } = state.session;
		state.unregisterHookCaller?.();
		state.unregisterHookCaller = registerMcpHookCaller(pi.events, async (request) => {
			const callSignal = AbortSignal.any([signal, request.signal]);
			callSignal.throwIfAborted();
			const server = state.findServer(request.server);
			if (!server || !isEnabled(server)) throw new Error(`MCP server "${request.server}" is unavailable`);
			if (request.waitForConnection) await waitForServers(state, [server], callSignal);
			callSignal.throwIfAborted();
			const connection = server.connection;
			if (!connection || connection.state !== "connected")
				throw new Error(`MCP server "${request.server}" is not connected`);
			// The model path's checks: a hidden or no longer offered tool is not callable, and the host authorizes
			// the registered tool name (its permission gate) before the call reaches the server.
			const owner = `${server.entry.name}\0${request.tool}`;
			const toolName = [...state.toolOwners].find(([, value]) => value === owner)?.[0];
			if (
				!toolName ||
				state.toolExposure(server.entry, request.tool) === "hidden" ||
				!connection.tools.some((offered) => offered.name === request.tool)
			)
				throw new Error(`MCP tool "${request.server}/${request.tool}" is not available`);
			await request.authorize({ toolName, input: request.input });
			callSignal.throwIfAborted();
			const client = await connection.getClient();
			callSignal.throwIfAborted();
			return client.callTool(request.tool, request.input, { signal: callSignal, timeoutMs: connection.timeoutMs });
		});
		state.configuredEntries = loaded.servers;
		const registered = state.registeredServers();
		state.overridden = registered.overridden;
		state.servers = [
			...loaded.servers
				.filter(
					(entry) => !registered.servers.some((server) => mcpNamespace(server.entry.name) === mcpNamespace(entry.name)),
				)
				.map((entry) => ({ entry })),
			...registered.servers,
		];
		state.emitChange();
		// Tool search is activated from the config: the first prompt does not wait for
		// servers whose tools are not declared to the model, and a tool_search waits for them.
		ensureDiscoveryActive(state, ctx);
		const enabled = state.servers.filter(isEnabled);
		if (enabled.length === 0) {
			reportProblems(state, ctx);
			return;
		}
		// The MCP client loads only now, so sessions without servers never pay for it. Waiting one
		// event loop turn lets the first render happen before loading and connecting.
		const runtime = new Promise((resolve) => setImmediate(resolve)).then(() => loadMcpRuntime());
		state.pending = Promise.all(enabled.map((server) => startConnection(state, server, runtime)))
			.then(() => {
				if (!signal.aborted) reportProblems(state, ctx);
			})
			.catch((error: unknown) => {
				// The session may have been disposed meanwhile, which makes ctx stale.
				try {
					ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
				} catch {}
			});
	});

	// Navigating the tree restores the loadout of the target branch, which may not include tool_search yet.
	pi.on("session_tree", (_event, ctx) => {
		resetDiscoveryActivation(pi);
		ensureDiscoveryActive(state, ctx);
	});

	pi.on("model_select", (event, ctx) => {
		state.selectedModel = event.model;
		for (const connection of state.connections())
			if (connection.state === "connected") registerTools(state, connection);
		ensureDiscoveryActive(state, ctx);
	});

	// Every prompt lists the servers in the `mcp_servers` section as they are when it starts. Pi
	// appends the section to the conversation when it changed, for example after a server connected.
	// The first prompt waits for servers whose tools are declared to the model (`waitForDirectServers`);
	// other servers are waited for when a tool_search needs them (below).
	pi.on("before_agent_start", async (event, ctx) => {
		state.selectedModel = ctx.model;
		if (!ctx.signal?.aborted && !state.session.signal.aborted) {
			const changed = state.servers.filter((server) => {
				const launched = server.connection && state.preparedLaunches.get(server.connection);
				return (
					isEnabled(server) &&
					server.connection?.idle &&
					!server.connection.isStopped &&
					launched &&
					!isDeepStrictEqual(launched, state.prepareLaunch(server.entry, state.sessionCwd))
				);
			});
			for (const server of changed) void state.track(reconnect(server));
			await waitForServers(state, changed, ctx.signal);
		}
		await waitForDirectServers(state, ctx);
		state.settleAutomaticExposure();
		for (const connection of state.connections())
			if (connection.state === "connected") registerTools(state, connection);
		ensureDiscoveryActive(state, ctx);
		const { sections } = event.systemPromptOptions;
		const section = renderServersSection(serverListings(state));
		if (section) sections[MCP_SERVERS_SECTION] = section;
		else delete sections[MCP_SERVERS_SECTION];
	});

	// Discovery waits for its requested namespaces.
	// A direct MCP call waits only for its server, including a pending reconnect.
	pi.on("tool_call", async (event, ctx) => {
		const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
		if (!tool) return;
		// Readiness can be pending while the display state is still connected: reconnect first
		// closes the old transport, then opens a new one. Settled promises return immediately.
		const readyServers = state.servers.filter((server) => isEnabled(server) && server.ready);
		if (readyServers.length === 0) return;
		let waiting: McpServer[] = [];
		const reach = tool.reachesTools?.(event.input);
		if (reach !== undefined) {
			waiting = readyServers.filter((server) => reachesServer(reach, server.entry.name));
		} else {
			const owner = state.toolOwners.get(event.toolName)?.split("\0", 1)[0];
			waiting = readyServers.filter((server) => server.entry.name === owner);
		}
		await waitForServers(state, waiting, ctx.signal);
	});

	// Pick up sign-ins done outside the session, such as `pi mcp login` run by the agent.
	pi.on("turn_start", async (_event, ctx) => {
		if (state.tokensAtSignIn.size > 0) await reconnectSignedIn(state, ctx);
	});

	// Servers registered or unregistered during the session connect or disconnect right away.
	pi.on("mcp_servers_change", async (_event, ctx) => {
		const { signal } = state.session;
		if (signal.aborted) return;
		const registered = state.registeredServers();
		state.overridden = registered.overridden;
		const defaults = state.configuredEntries
			.filter(
				(entry) =>
					entry.scope === "default" &&
					!registered.servers.some((server) => mcpNamespace(server.entry.name) === mcpNamespace(entry.name)),
			)
			.map((entry) => ({ entry }));
		const desired: McpServer[] = [...registered.servers, ...defaults];
		const next = new Map(desired.map((server) => [mcpNamespace(server.entry.name), server]));
		// Unregistered servers and re-registered ones with a new config are dropped; the latter come back below.
		const removed = state.servers.filter(
			(server) =>
				(server.entry.scope === "extension" &&
					next.get(mcpNamespace(server.entry.name))?.registeredConfig !== server.registeredConfig) ||
				(server.entry.scope === "default" && next.get(mcpNamespace(server.entry.name))?.entry.scope === "extension"),
		);
		state.servers = state.servers.filter((server) => !removed.includes(server));
		for (const server of removed) hideTools(state, server.entry.name);
		const added = desired.filter(
			(server) =>
				!state.servers.some((current) => mcpNamespace(current.entry.name) === mcpNamespace(server.entry.name)),
		);
		state.servers.push(...added);
		state.emitChange();
		ensureDiscoveryActive(state, ctx);
		await Promise.all(removed.flatMap((server) => server.connection?.close() ?? []));
		const connecting = added.filter(isEnabled);
		if (signal.aborted || connecting.length === 0) return;
		try {
			await Promise.all(connecting.map((server) => startConnection(state, server)));
			if (signal.aborted) {
				await Promise.all(connecting.flatMap((server) => server.connection?.close() ?? []));
				return;
			}
		} catch (error) {
			ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
			return;
		}
		if (signal.aborted) return;
		reportProblems(state, ctx, connecting);
	});

	pi.on("session_shutdown", async () => {
		state.unregisterHookCaller?.();
		state.unregisterHookCaller = undefined;
		state.session.abort();
		const closing = state.connections();
		state.servers = [];
		state.emitChange();
		await Promise.all([...state.backgroundActions, ...closing.map((connection) => connection.close())]);
	});
}
