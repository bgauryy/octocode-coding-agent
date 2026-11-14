import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";

/**
 * Whether external agents are available (the global `externalAgents` setting, on by default).
 * Read from the global settings only, the way research roots are: tools are declared before a project is known, and a
 * project file must not be able to switch on reaching outside agents.
 */
export function externalAgentsEnabled(agentDir: string = getAgentDir()): boolean {
	try {
		const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
		if (settings.drainErrors().length) return false;
		return settings.getExternalAgents();
	} catch {
		return false;
	}
}
