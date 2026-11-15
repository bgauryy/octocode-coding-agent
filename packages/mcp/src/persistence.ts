/** Saves `/mcp` configuration changes to the server's file and the running session's entry. */

import { applyMcpServerPatch, type McpServerConfigPatch } from "./config.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { McpServer } from "./server.ts";
import type { McpExtensionState } from "./state.ts";

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
	// Keep the session and file consistent: defaults remove their keys, while overrides retain them.
	const config = { ...entry.config };
	applyMcpServerPatch(config, patch, entry.override !== undefined);
	server.entry = { ...entry, config };
	state.configuredEntries = state.configuredEntries.map((current) =>
		current.name === entry.name ? server.entry : current,
	);
	return undefined;
}
