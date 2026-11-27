import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";

export interface ExternalAgentSelection {
	enabled: boolean;
	runners?: readonly string[];
}

/** Read the global opt-in and runner selection together; a project cannot enable external agents. */
export function externalAgentSelection(agentDir: string = getAgentDir()): ExternalAgentSelection {
	try {
		const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
		if (settings.drainErrors().length) return { enabled: false, runners: [] };
		return { enabled: settings.getExternalAgents(), runners: settings.getEnabledExternalAgents() };
	} catch {
		return { enabled: false, runners: [] };
	}
}

export function externalAgentsEnabled(agentDir: string = getAgentDir()): boolean {
	return externalAgentSelection(agentDir).enabled;
}
