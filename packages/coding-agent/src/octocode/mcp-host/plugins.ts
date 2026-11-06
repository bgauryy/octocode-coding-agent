/**
 * The MCP workspace's plugins port: the servers enabled plugins declare, read from the settings in effect (project
 * plugins only for a trusted folder), as the session's resource loader registers them.
 */

import { effectivePlugins } from "../../core/extensibility/toggles.ts";
import { loadConfiguredPluginMcp } from "../../core/plugin-mcp.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { McpHostPorts } from "../../../../mcp/src/host.ts";

export const plugins: McpHostPorts["plugins"] = {
	servers({ cwd, agentDir, projectTrusted }) {
		const manager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const problems = manager.drainErrors().map((problem) => `Cannot read ${problem.path}: ${problem.error.message}`);
		const loaded = loadConfiguredPluginMcp(effectivePlugins(manager.getSettings(), cwd), cwd);
		return { servers: loaded.servers, errors: [...problems, ...loaded.errors] };
	},
};
