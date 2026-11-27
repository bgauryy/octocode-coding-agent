import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { setShellKeepsProviderKeys } from "../../utils/shell.ts";

/**
 * Applies `bash.inheritProviderKeys`, read from the global settings only: a project file must not be able to hand the
 * user's provider keys to the commands of that project. Unreadable settings keep the default, which removes them.
 */
export function applyBashEnvironmentSetting(agentDir: string = getAgentDir()): void {
	let keep = false;
	try {
		keep = SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getBashInheritProviderKeys();
	} catch {
		// The default stands.
	}
	setShellKeepsProviderKeys(keep);
}
