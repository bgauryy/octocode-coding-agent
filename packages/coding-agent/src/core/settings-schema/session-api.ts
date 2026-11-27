import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** Global-only `sessionApiTurnPermission` setting; `sessionApiTurnCeiling` (octocode/api/enabled.ts) is the one reader. */
export const SessionApiTurnPermissionSchema = Type.Union([Type.Literal("workspace"), Type.Literal("session")], {
	description:
		"The permission mode a turn the local session API starts runs under. `session` (default) follows the session's own mode: a session in full takes the message unasked and runs the turn in full, audited, so a remote agent is never stuck on a prompt; workspace and manual sessions ask as they always do. `workspace` holds API-started turns, and messages that steer a running turn, to workspace mode even when the session is in full: its user is asked about the message, and a tool call workspace asks about asks or, with nobody to ask, is refused. Read from the global settings file; a project file cannot change it. Applies to the next message.",
	default: SETTINGS_DEFAULTS.sessionApiTurnPermission,
});
