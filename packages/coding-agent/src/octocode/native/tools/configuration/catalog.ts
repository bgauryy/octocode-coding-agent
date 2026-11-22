import { getAgentDir } from "../../../../config.ts";
import { type ConfigCatalog, createConfiguration } from "../../../../configuration/index.ts";
import type { FeatureContext, FeatureSetup } from "../../../../core/features/index.ts";
import { SettingsManager } from "../../../../core/settings-manager.ts";
import { getMcpSessionStatus, getMcpSwitch, requestMcpReload } from "../../../../../../mcp/src/api.ts";

/**
 * The catalog `/settings` uses, over a settings manager that reads and writes the same files. A change reaches the
 * MCP owner at once through its switch; settings keys apply as each result says (the files are written, `/reload` reads them).
 */
export function sessionCatalog(api: FeatureSetup, ctx: FeatureContext): ConfigCatalog {
	const projectTrusted = ctx.isProjectTrusted();
	const agentDir = getAgentDir();
	return createConfiguration({
		cwd: ctx.cwd,
		agentDir,
		projectTrusted,
		settings: SettingsManager.create(ctx.cwd, agentDir, { projectTrusted }),
		live: {
			mcpSwitch: getMcpSwitch(api.channels),
			mcpReload: () => requestMcpReload(api.channels),
			mcpStatus: () => getMcpSessionStatus(api.channels),
		},
	});
}
