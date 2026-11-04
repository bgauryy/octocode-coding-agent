import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";

/**
 * Whether sessions start their API (the `sessionApi` setting, on by default). Read from the global settings only, as
 * `externalAgents` is: a project file must not be able to switch back on what the user turned off.
 */
export function sessionApiEnabled(agentDir: string = getAgentDir()): boolean {
	try {
		return SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getSessionApi();
	} catch {
		return true;
	}
}
