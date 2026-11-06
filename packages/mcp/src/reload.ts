/**
 * Applying a change of the configured server set during a session: servers registered by extensions
 * (`mcp_servers_change`) and a config reload (`requestMcpReload`, after `/harness` switches a vendor) share it.
 */

import { isDeepStrictEqual } from "node:util";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { mcpNamespace } from "../../common/src/mcp-names.ts";
import type { LoadedMcpConfig } from "./config.ts";
import { startConnection } from "./connections.ts";
import { isSelected } from "./exposure.ts";
import type { McpContext } from "./host/types.ts";
import { sayUntrustedProject } from "./notice.ts";
import { reportProblems } from "./report.ts";
import { isEnabled, type McpServer } from "./server.ts";
import type { McpExtensionState } from "./state.ts";
import type { McpReloadResult } from "./switch.ts";
import { hideTools } from "./tool-registry.ts";

/** Drop `removed` (closing their connections), add `added` and connect those enabled and selected. */
export async function applyServerChanges(
	state: McpExtensionState,
	ctx: McpContext,
	removed: readonly McpServer[],
	added: readonly McpServer[],
): Promise<void> {
	const { signal } = state.session;
	state.servers = state.servers.filter((server) => !removed.includes(server));
	for (const server of removed) hideTools(state, server.entry.name);
	for (const server of added) server.unselected = isEnabled(server) && !isSelected(state.api, server.entry);
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
}

/** Whether `server` must close because `desired` (its namespace's wanted server, if any) differs from it. */
function outdated(server: McpServer, desired: McpServer | undefined): boolean {
	if (!desired) return true;
	if (server.entry.scope === "extension" || desired.entry.scope === "extension")
		return server.entry.scope !== desired.entry.scope || server.registeredConfig !== desired.registeredConfig;
	return !isDeepStrictEqual(server.entry, desired.entry);
}

/**
 * Re-read the config files (`load`, with the current settings) and apply the difference to the running session:
 * servers no longer configured close, new ones connect, and a changed definition restarts. The next request's `<mcps>`
 * block describes the result.
 */
export async function reloadMcpConfig(
	state: McpExtensionState,
	ctx: McpContext,
	load: () => LoadedMcpConfig,
): Promise<McpReloadResult> {
	state.session.signal.throwIfAborted();
	const loaded = load();
	sayUntrustedProject(ctx);
	state.configErrors = loaded.errors;
	state.projectConfig = loaded.projectConfig;
	state.globalConfig = loaded.globalConfig;
	state.configuredEntries = loaded.servers;
	const registered = state.registeredServers();
	state.overridden = registered.overridden;
	const taken = new Set(registered.servers.map((server) => mcpNamespace(server.entry.name)));
	const desired: McpServer[] = [
		...loaded.servers
			.filter((entry) => !taken.has(mcpNamespace(entry.name)))
			.filter((entry) => !state.leavesOut(entry.name))
			.map((entry) => ({ entry })),
		...registered.servers,
	];
	const next = new Map(desired.map((server) => [mcpNamespace(server.entry.name), server]));
	const removed = state.servers.filter((server) => outdated(server, next.get(mcpNamespace(server.entry.name))));
	const kept = new Set(
		state.servers.filter((server) => !removed.includes(server)).map((server) => mcpNamespace(server.entry.name)),
	);
	const added = desired.filter((server) => !kept.has(mcpNamespace(server.entry.name)));
	await applyServerChanges(state, ctx, removed, added);
	return { added: added.map((server) => server.entry.name), removed: removed.map((server) => server.entry.name) };
}
