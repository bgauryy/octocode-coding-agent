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
import { isSelected } from "./exposure.ts";
import {
	MCP_CONTRACT_SECTION_PREFIX,
	MCP_STATUS_SECTION,
	type McpServerListing,
	renderContractSections,
	renderStatusSection,
} from "./section.ts";
import { errorMessage } from "../../coding-agent/src/utils/guards.ts";
import { isEnabled, type McpServer } from "./server.ts";
import type { McpExtensionState } from "./state.ts";
import { hideTools, registerTools } from "./tool-registry.ts";

/**
 * The servers the prompt describes: enabled servers this session's selection reaches, with their tools as the active
 * tool set declares them. A thin declared tool is described by the server's frozen generated file; the file stays while
 * the server reconnects, so a state change does not resend it.
 */
function serverListings(state: McpExtensionState): McpServerListing[] {
	const active = new Set(state.pi.getActiveTools());
	return state.servers.flatMap((server) => {
		if (!isEnabled(server) || server.unselected) return [];
		const declared = [...(state.serverTools.get(server.entry.name) ?? [])].filter(
			(name) => active.has(name) && state.definitions.get(name)?.exposure === "direct",
		);
		const thin = declared.filter((name) => state.definitions.get(name)?.validationParameters);
		const file = state.presentation.section(
			server.entry.name,
			thin.map((name) => state.toolOwners.get(name)?.split("\0")[1] ?? name),
		);
		return [
			{
				entry: server.entry,
				state: server.connection?.isStopped ? "stopped" : (server.connection?.state ?? "connecting"),
				...(server.connection?.instructions ? { instructions: server.connection.instructions } : {}),
				declared: declared.length > 0,
				...(file ? { file } : {}),
			},
		];
	});
}

function defaultLoadConfig(ctx: ExtensionContext, defaults: readonly McpServerEntry[]): LoadedMcpConfig {
	return loadMcpConfig({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), defaults });
}

export function registerSessionEvents(state: McpExtensionState): void {
	const { pi, options } = state;

	pi.on("session_start", (_event, ctx) => {
		state.presentation.reset();
		const loaded = (options.loadConfig ?? defaultLoadConfig)(ctx, presetEntries(options.presets ?? []));
		state.configErrors = loaded.errors;
		state.projectConfig = loaded.projectConfig;
		state.globalConfig = loaded.globalConfig;
		state.projectTrusted = ctx.isProjectTrusted();
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
			// A server outside the tool selection starts for the hook alone; its tools stay undeclared.
			if (server.unselected && !server.connection) void state.track(startConnection(state, server, undefined, false));
			if (request.waitForConnection || server.unselected) await waitForServers(state, [server], callSignal);
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
			// Through the connection's request path like the model's calls: expired-session retry, sign-in marking and
			// retiring-client accounting.
			return connection.callTool(request.tool, request.input, { signal: callSignal, timeoutMs: connection.timeoutMs });
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
		for (const server of state.servers) server.unselected = isEnabled(server) && !isSelected(state.pi, server.entry);
		state.emitChange();
		const enabled = state.servers.filter((server) => isEnabled(server) && !server.unselected);
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

	// Navigating the tree rebuilds the loadout of the target branch, and with it the prompt.
	pi.on("session_tree", () => {
		state.presentation.rebuild();
	});

	pi.on("model_select", () => {
		state.presentation.rebuild();
		for (const connection of state.connections())
			if (connection.state === "connected") registerTools(state, connection);
	});

	// Every prompt describes the servers as they are when it starts: each server's contract is a base section (cached
	// with the tools, ahead of project context) and servers that are not connected are named in `mcp_status`. Pi appends
	// a section to the conversation when it changed, for example after a server connected. The first prompt waits for
	// servers whose tools are declared to the model (`waitForDirectServers`).
	pi.on("before_agent_start", async (event, ctx) => {
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
		for (const connection of state.connections())
			if (connection.state === "connected") registerTools(state, connection);
		// A new or changed catalog whose tools keep the server's own wording: tell the user, never the model.
		for (const { server, tools } of state.presentation.takeUnoptimized())
			ctx.ui.notify(
				`MCP server "${server}": ${tools.length} tool description${tools.length === 1 ? "" : "s"} not yet rewritten for its compact file (${tools.join(", ")}). The octocode-compact-mcp skill rewrites them.`,
				"info",
			);
		const { sections, baseSections } = event.systemPromptOptions;
		const listings = serverListings(state);
		const status = renderStatusSection(listings);
		if (status) sections[MCP_STATUS_SECTION] = status;
		else delete sections[MCP_STATUS_SECTION];
		const contracts = renderContractSections(listings);
		for (const name of Object.keys(baseSections))
			if (name.startsWith(MCP_CONTRACT_SECTION_PREFIX) && !(name in contracts)) delete baseSections[name];
		Object.assign(baseSections, contracts);
	});

	// An MCP call waits only for its server, including a pending reconnect. Readiness can be pending while the display
	// state is still connected: reconnect first closes the old transport, then opens a new one. Settled promises return
	// immediately.
	pi.on("tool_call", async (event, ctx) => {
		const owner = state.toolOwners.get(event.toolName)?.split("\0", 1)[0];
		if (owner === undefined) return;
		const waiting = state.servers.filter((server) => isEnabled(server) && server.ready && server.entry.name === owner);
		await waitForServers(state, waiting, ctx.signal);
	});

	// Pick up sign-ins done outside the session, such as `pi mcp login` run by the agent.
	pi.on("turn_start", async () => {
		if (state.tokensAtSignIn.size > 0) await reconnectSignedIn(state);
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
		for (const server of added) server.unselected = isEnabled(server) && !isSelected(state.pi, server.entry);
		state.servers.push(...added);
		state.emitChange();
		await Promise.all(removed.flatMap((server) => server.connection?.close() ?? []));
		const connecting = added.filter((server) => isEnabled(server) && !server.unselected);
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
		await Promise.all([
			...state.backgroundActions,
			...closing.map((connection) => connection.close()),
			...(state.options.presets ?? []).map((preset) => preset.dispose?.()),
		]);
	});
}
