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
 * The mode a turn an API client starts is held to (the `sessionApiTurnPermission` setting): none by default, so the turn
 * runs in the session's own mode (a session in `full` takes the message and runs the turn unasked, audited, and a remote
 * agent is never stuck on a prompt), and `workspace` holds API-started turns, and messages that steer a running turn,
 * to `workspace` even in a `full` session. Read from the global settings only: a project file must not change what the
 * user set. Only an explicit `workspace` holds the turn.
 */
export function sessionApiTurnCeiling(agentDir: string = getAgentDir()): TurnCeiling | undefined {
	try {
		const settings = SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getGlobalSettings();
		return settings.sessionApiTurnPermission === "workspace" ? "workspace" : undefined;
	} catch {
		return undefined;
	}
}
