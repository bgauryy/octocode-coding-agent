import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** Global-only `sessionApiTurnPermission` setting; `sessionApiTurnCeiling` (octocode/api/enabled.ts) is the one reader. */
export const SessionApiTurnPermissionSchema = Type.Union([Type.Literal("workspace"), Type.Literal("session")], {
	description:
		"The permission mode a turn the local session API starts on an idle session runs under. `workspace` (default) holds it to workspace mode even when the session is in full: its user is asked about the message, and a tool call workspace asks about asks or, with nobody to ask, is refused. `session` restores the session's own mode (full takes the message unasked and runs the turn in full). A message to a session that is already working follows the session's mode either way. Read from the global settings file; a project file cannot change it. Applies to the next message.",
	default: SETTINGS_DEFAULTS.sessionApiTurnPermission,
});
