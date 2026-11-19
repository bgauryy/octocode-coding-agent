/** Session events: load and connect servers, declare their tools per prompt, wait for them, and shut down. */

import { isDeepStrictEqual } from "node:util";
import { presetEntries } from "./preset.ts";
import { applyServerChanges, reloadMcpConfig } from "./reload.ts";
import { hostPaths } from "./host.ts";
import type { McpContext } from "./host/types.ts";
import { type McpServerEntry, type LoadedMcpConfig, loadMcpConfig } from "./config.ts";
import { reconnect, reconnectSignedIn, startConnection, waitForDirectServers, waitForServers } from "./connections.ts";
import { registerMcpHookCaller } from "./hook-caller.ts";
import { boundHookResult } from "./hook-result.ts";
import { registerMcpReload, registerMcpSwitch, switchMcpServer } from "./switch.ts";
import { reportProblems } from "./report.ts";
import { say, sayUntrustedProject } from "./notice.ts";
import { loadMcpRuntime } from "./runtime.lazy.ts";
import { envFlag, SKILL_SNAPSHOT_FILE_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { mcpNamespace } from "@octocodeai/octocode-common/mcp-names";
import { isSelected } from "./exposure.ts";
import { serverListings } from "./listings.ts";
import { forgetOnDemandLoads, setOnDemandModel } from "./on-demand.ts";
import { restoreRecentTools, saveRecentTools } from "./recent-session.ts";
import { handOver, takeHanded } from "./handover.ts";
import {
	MCP_STATUS_SECTION,
	MCPS_SECTION,
	mcpServerPurposes,
	renderMcpStatusSection,
	renderMcpsSection,
	mcpBlockContracts,
} from "./section.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { declaredParameters, redeclaresInPlace } from "./redeclare.ts";
import { isEnabled, type McpServer } from "./server.ts";
import type { McpFeatureState } from "./state.ts";
import { loadOnDemand, registerTools } from "./tool-registry.ts";
import { preparedCallOf } from "./tool-definition.ts";
import { takeLaunchWarnings } from "./warnings.ts";

/** Whether the launch the server would get now differs from the one it got; a launch that cannot be prepared does not count. */
function launchChanged(state: McpFeatureState, server: McpServer, launched: McpServerEntry): boolean {
	try {
		return !isDeepStrictEqual(launched, state.prepareLaunch(server.entry, state.sessionCwd));
	} catch {
		return false;
	}
}

/**
 * Write the `mcps` base section, the server purposes of the `tools` overview (`mcpServers`) and the `mcp_status`
 * section for one request. Describing comes first: a thin
 * declaration needs the block that describes it (`McpPresentation.isThin`), so connected servers re-register after.
 */
function describeServers(
	state: McpFeatureState,
	options: {
		baseSections: Record<string, string>;
		sections: Record<string, string>;
		mcpServers?: Record<string, string>;
	},
): void {
	const listings = serverListings(state);
	for (const connection of state.connections()) if (connection.state === "connected") registerTools(state, connection);
	options.mcpServers = mcpServerPurposes(listings);
	const mcps = renderMcpsSection(listings, { declared: state.presentation.declared });
	if (mcps) options.baseSections[MCPS_SECTION] = mcps;
	else delete options.baseSections[MCPS_SECTION];
	state.promptContracts.clear();
	if (mcps)
		for (const [name, contract] of mcpBlockContracts(listings, { declared: state.presentation.declared }))
			state.promptContracts.set(name, contract);
	const status = renderMcpStatusSection(listings, {
		canManage: state.api.tools.getActive().includes("mcp"),
		// A server the user switched off is not awaiting approval: only switched-on servers the review holds back are named.
		withheld: state.servers
			.filter((server) => server.entry.withheld && server.entry.config.enabled !== false)
			.map((server) => server.entry.name),
	});
	if (status) options.sections[MCP_STATUS_SECTION] = status;
	else delete options.sections[MCP_STATUS_SECTION];
}

function defaultLoadConfig(ctx: McpContext, defaults: readonly McpServerEntry[]): LoadedMcpConfig {
	return loadMcpConfig({
		agentDir: hostPaths().agentDir(),
		cwd: ctx.cwd,
		projectTrusted: ctx.isProjectTrusted(),
		defaults,
	});
}

export function registerSessionEvents(state: McpFeatureState): void {
	const { api, options } = state;

	api.bus.on("session_start", (_event, ctx) => {
		state.presentation.reset();
		state.declaredBefore = declaredParameters(ctx);
		forgetOnDemandLoads(state);
		setOnDemandModel(state, ctx.model);
		const load = () => (options.loadConfig ?? defaultLoadConfig)(ctx, presetEntries(options.presets ?? []));
		const loaded = load();
		state.configErrors = loaded.errors;
		state.projectConfig = loaded.projectConfig;
		state.globalConfig = loaded.globalConfig;
		state.projectTrusted = ctx.isProjectTrusted();
		sayUntrustedProject(ctx);
		state.waitedForStartup = false;
		state.startupGate.close();
		// A subagent that runs on its coordinator's skill snapshot has its skill folders already: discovery cannot change
		// its servers' launches, so they start now instead of after every other start handler.
		if (envFlag(process.env, SUBAGENT_ENV) && process.env[SKILL_SNAPSHOT_FILE_ENV]) state.startupGate.open();
		state.sessionCwd = ctx.cwd;
		// The recent-tool set is read per folder, so it is dropped once the new folder is set; a session that saved the
		// set it declared declares it again (`recent-session.ts`), so a resume keeps the provider's cached prompt.
		restoreRecentTools(state, ctx);
		state.modelRegistry = ctx.modelRegistry;
		state.session = new AbortController();
		const { signal } = state.session;
		state.unregisterSwitch?.();
		state.unregisterSwitch = registerMcpSwitch(api.channels, (request) => switchMcpServer(state, request));
		state.unregisterReload?.();
		state.unregisterReload = registerMcpReload(api.channels, () => state.track(reloadMcpConfig(state, ctx, load)));
		state.unregisterHookCaller?.();
		state.unregisterHookCaller = registerMcpHookCaller(api.channels, async (request) => {
			const callSignal = AbortSignal.any([signal, request.signal]);
			callSignal.throwIfAborted();
			// A hook may call during `session_start`, before discovery: its server cannot wait for it.
			state.startupGate.open();
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
			// The model path's preparation and review (a preset's safety boundary, such as the browser's network filter):
			// a refusal rejects the hook call, and a tool without a preparation is not called unfiltered.
			const prepare = preparedCallOf(state.definitions.get(toolName) ?? {});
			if (!prepare) throw new Error(`MCP tool "${request.server}/${request.tool}" is not available`);
			const call = await prepare(request.input, Object.create(ctx, { signal: { value: callSignal } }) as typeof ctx);
			callSignal.throwIfAborted();
			// Through the connection's request path like the model's calls: expired-session retry, sign-in marking and
			// retiring-client accounting.
			// A progress handler sends a progress token, so a server's progress keeps the idle timeout from expiring.
			const reply = await connection.callTool(request.tool, call.args, {
				signal: callSignal,
				timeoutMs: connection.timeoutMs,
				onProgress: () => undefined,
			});
			return boundHookResult(call.review ? call.review(reply) : reply, `mcp ${request.server}/${request.tool}`);
		});
		state.configuredEntries = loaded.servers;
		const registered = state.registeredServers();
		state.overridden = registered.overridden;
		state.servers = [
			...loaded.servers
				.filter(
					(entry) => !registered.servers.some((server) => mcpNamespace(server.entry.name) === mcpNamespace(entry.name)),
				)
				.filter((entry) => !state.leavesOut(entry.name))
				.map((entry) => ({ entry })),
			...registered.servers,
		];
		for (const server of state.servers)
			server.unselected = isEnabled(server) && !isSelected(state.api, server.entry, state.taskNamed);
		state.emitChange();
		const enabled = state.servers.filter((server) => isEnabled(server) && !server.unselected);
		// What the replaced session handed over (`handover.ts`): the servers started here may keep their process.
		const { taken, closing } = takeHanded(enabled);
		for (const close of closing) void state.track(close);
		if (enabled.length === 0) {
			reportProblems(state, ctx);
			return;
		}
		// The MCP client loads only now, so sessions without servers never pay for it. Waiting for the session's
		// resources (`startup-gate.ts`) also lets the first render happen before loading and connecting.
		const runtime = state.startupGate.ready.then(() => loadMcpRuntime());
		state.pending = Promise.all(
			enabled.map((server) => {
				const handed = taken.get(server.entry.name);
				const start = startConnection(state, server, runtime, true, handed);
				// The session's end waits for a handed connection to be adopted or closed.
				return handed ? state.track(start) : start;
			}),
		)
			.then(() => {
				if (!signal.aborted) reportProblems(state, ctx);
			})
			.catch((error: unknown) => {
				// The session may have been disposed meanwhile, which makes ctx stale.
				try {
					ctx.ui.notify(`MCP failed to load: ${errorMessage(error)}`, "error");
				} catch {
					// No session is left to show the notice.
				}
			});
	});

	// Navigating the tree rebuilds the loadout of the target branch, and with it the prompt.
	api.bus.on("session_tree", (_event, ctx) => {
		state.presentation.rebuild();
		state.presentation.forgetLoaded();
		forgetOnDemandLoads(state);
		state.declaredBefore = declaredParameters(ctx);
	});

	// A deferred tool is declared in full after its first call, successful or not, where the model's transport adds the
	// definition in place (`redeclare.ts`); elsewhere it stays thin. The next request registers it (`describeServers`).
	api.bus.on("tool_execution_end", (event: { toolName?: unknown }, ctx) => {
		const [server, tool] =
			(typeof event.toolName === "string" ? state.toolOwners.get(event.toolName) : undefined)?.split("\0") ?? [];
		if (server !== undefined && tool !== undefined && redeclaresInPlace(ctx.model))
			state.presentation.load(server, tool);
	});

	// A switch to a transport without in-place additions declares every unloaded on-demand tool deferred; its cache is
	// cold anyway. A switch the other way never takes a declaration back.
	api.bus.on("model_select", (_event, ctx) => {
		setOnDemandModel(state, ctx.model);
		state.presentation.rebuild();
		for (const connection of state.connections())
			if (connection.state === "connected") registerTools(state, connection);
	});

	// The host applies the folders features add right after this event: the startup connections launch with them.
	api.bus.on("resources_discover", () => {
		state.startupGate.discovered();
	});

	// Every prompt describes the servers: the `mcps` base section (cached with the tools, ahead of project context) holds
	// each server's block, fixed once its catalog is described, and the volatile `mcp_status` section names servers that
	// are not ready. A connection change therefore patches only `mcp_status`. The first prompt waits for servers whose
	// tools are declared to the model (`waitForDirectServers`).
	api.bus.on("before_agent_start", async (event, ctx) => {
		state.startupGate.open();
		if (!ctx.signal?.aborted && !state.session.signal.aborted) {
			const changed = state.servers.filter((server) => {
				const launched = server.connection && state.preparedLaunches.get(server.connection);
				return (
					isEnabled(server) &&
					server.connection?.idle &&
					!server.connection.isStopped &&
					launched &&
					launchChanged(state, server, launched)
				);
			});
			for (const server of changed) void state.track(reconnect(server));
			await waitForServers(state, changed, ctx.signal);
		}
		await waitForDirectServers(state, ctx);
		// Launch warnings (an allowed folder that was refused, say): tell the user, never the model.
		const warnings = [
			...takeLaunchWarnings(),
			...(state.options.presets ?? []).flatMap((preset) => preset.takeWarnings?.() ?? []),
		];
		for (const warning of warnings) say(ctx, warning, "warning");
		describeServers(state, event.systemPromptOptions);
	});

	// Within a run, every later request describes the servers again, so a server that connects mid-run gets its block
	// (and thin declarations) on the next turn, and a state change patches only `mcp_status`.
	api.bus.on("turn_prompt", (event) => {
		describeServers(state, event.systemPromptOptions);
	});

	// An MCP call waits only for its server, including a pending reconnect. Readiness can be pending while the display
	// state is still connected: reconnect first closes the old transport, then opens a new one. Settled promises return
	// immediately.
	api.bus.on("tool_call", async (event, ctx) => {
		const [owner, tool] = state.toolOwners.get(event.toolName)?.split("\0") ?? [];
		if (owner === undefined) return;
		// A call to an on-demand tool registered undeclared: the host activated it for this call.
		if (tool !== undefined && loadOnDemand(state, owner, tool)) state.recordToolLoaded(owner, tool, "calledUndeclared");
		const waiting = state.servers.filter((server) => isEnabled(server) && server.ready && server.entry.name === owner);
		await waitForServers(state, waiting, ctx.signal);
	});

	// Pick up sign-ins done outside the session, such as `octocode mcp login` run by the agent.
	api.bus.on("turn_start", async () => {
		if (state.tokensAtSignIn.size > 0) await reconnectSignedIn(state);
	});

	// Servers registered or unregistered during the session connect or disconnect right away.
	api.bus.on("mcp_servers_change", async (_event, ctx) => {
		const { signal } = state.session;
		if (signal.aborted) return;
		const registered = state.registeredServers();
		state.overridden = registered.overridden;
		const defaults = state.configuredEntries
			.filter(
				(entry) =>
					entry.scope === "default" &&
					!state.leavesOut(entry.name) &&
					!registered.servers.some((server) => mcpNamespace(server.entry.name) === mcpNamespace(entry.name)),
			)
			.map((entry) => ({ entry }));
		const desired: McpServer[] = [...registered.servers, ...defaults];
		const next = new Map(desired.map((server) => [mcpNamespace(server.entry.name), server]));
		// Unregistered servers and re-registered ones with a new config are dropped; the latter come back below.
		const removed = state.servers.filter(
			(server) =>
				(server.entry.scope === "feature" &&
					next.get(mcpNamespace(server.entry.name))?.registeredConfig !== server.registeredConfig) ||
				(server.entry.scope === "default" && next.get(mcpNamespace(server.entry.name))?.entry.scope === "feature"),
		);
		const added = desired.filter(
			(server) =>
				!state.servers.some(
					(current) =>
						!removed.includes(current) && mcpNamespace(current.entry.name) === mcpNamespace(server.entry.name),
				),
		);
		await applyServerChanges(state, ctx, removed, added);
	});

	api.bus.on("agent_start", () => saveRecentTools(state));

	api.bus.on("session_shutdown", async (event: { reason?: unknown }) => {
		// Nothing launches after the abort below; what waited for the gate settles.
		state.startupGate.open();
		state.unregisterHookCaller?.();
		state.unregisterHookCaller = undefined;
		state.unregisterSwitch?.();
		state.unregisterSwitch = undefined;
		state.unregisterReload?.();
		state.unregisterReload = undefined;
		state.session.abort();
		// A session replaced by another in this process hands its idle connections over; the rest close.
		const { closing } = handOver(state, event?.reason);
		state.servers = [];
		state.emitChange();
		await Promise.all([
			...state.backgroundActions,
			...closing,
			...(state.options.presets ?? []).map((preset) => preset.dispose?.(state.sessionCwd)),
		]);
	});
}
