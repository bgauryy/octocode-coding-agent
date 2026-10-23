/** Saves `/mcp` configuration changes and applies exposure changes to the registered tools. */

import type { McpExposure, McpServerConfigPatch } from "./config.ts";
import { errorMessage, type McpServer } from "./server.ts";
import type { McpExtensionState } from "./state.ts";
import { registerTools, syncResourceTools } from "./tool-registry.ts";

/**
 * Save a config change; returns an error message when the file could not be updated. Changes to
 * registered servers only apply to the current session. `inProject` adds a project override.
 */
export function saveConfig(
	state: McpExtensionState,
	server: McpServer,
	patch: McpServerConfigPatch,
	inProject = false,
): string | undefined {
	const { projectConfig } = state;
	if (inProject && !projectConfig) return "Project configuration requires a trusted project.";
	const existing = server.entry;
	const projectOverride = existing.override && existing.overrideScope !== "global";
	const target = inProject ? projectConfig : state.configPath(existing);
	const override = target && target !== existing.source ? target : existing.override;
	const overrideScope = inProject || projectOverride ? ("project" as const) : ("global" as const);
	const entry = override ? { ...existing, override, overrideScope } : existing;
	if (entry.scope !== "extension") {
		try {
			state.updateConfig(entry, patch);
		} catch (error) {
			return `Could not update ${entry.override ?? entry.source}: ${errorMessage(error)}`;
		}
	}
	server.entry = { ...entry, config: { ...entry.config, ...patch } };
	return undefined;
}

export function setExposure(
	state: McpExtensionState,
	server: McpServer,
	exposure: McpExposure,
	inProject = false,
): string | undefined {
	const { pi } = state;
	const failed = saveConfig(state, server, { exposure }, inProject);
	if (failed) return failed;
	if (server.connection?.state === "connected") registerTools(state, server.connection);
	syncResourceTools(state);
	// Tools no longer exposed directly leave the declared set; direct tools are activated on registration.
	const indirect = new Set(
		pi
			.getAllTools()
			.filter((tool) => tool.exposure !== "direct")
			.map((tool) => tool.name),
	);
	const tools = state.serverTools.get(server.entry.name) ?? new Set<string>();
	pi.setActiveTools(pi.getActiveTools().filter((name) => !tools.has(name) || !indirect.has(name)));
	state.emitChange();
	return undefined;
}
