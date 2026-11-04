import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import type { TurnCeiling } from "./bridge/contracts.ts";

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

/**
 * The mode a turn an API client starts on an idle session is held to (the `sessionApiTurnPermission` setting): `workspace`
 * by default, so a session in `full` still asks about what `workspace` asks about, and `session` (the old behavior) keeps
 * the session's own mode. Read from the global settings only: a project file must not loosen what the user set. A
 * missing, unknown or unreadable value holds the turn.
 */
export function sessionApiTurnCeiling(agentDir: string = getAgentDir()): TurnCeiling | undefined {
	try {
		const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getGlobalSettings();
		return settings.sessionApiTurnPermission === "session" ? undefined : "workspace";
	} catch {
		return "workspace";
	}
}
