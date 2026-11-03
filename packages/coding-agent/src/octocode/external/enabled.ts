import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";

/**
 * Whether the user opted in to the `agent` tool's `external` type (the `externalAgents` setting, off by default).
 * Read from the global settings only, the way research roots are: tools are declared before a project is known, and a
 * project file must not be able to switch on reaching outside agents.
 */
export function externalAgentsEnabled(agentDir: string = getAgentDir()): boolean {
	try {
		return SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getExternalAgents();
	} catch {
		return false;
	}
}
