import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/** Global-only `retention` setting; `resolveRetention` (config/retention.ts) is the one reader. */
export const RetentionSettingsSchema = Type.Object(
	{
		days: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"Days Octocode keeps output, bash logs, subagent scratch, session data, `<workspace>/.octocode/tmp` entries and database history after their last write. 0 keeps them forever. `OCTOCODE_CLEANUP_DAYS` overrides it.",
				default: SETTINGS_DEFAULTS.retention.days,
			}),
		),
		sessionDays: Type.Optional(
			Type.Integer({
				minimum: 0,
				description:
					"Days a session transcript (JSONL, in a workspace or the legacy per-folder directories) is kept after its last write, then removed with its session data and database rows; the current and running sessions are never removed. 0 keeps transcripts forever. `OCTOCODE_SESSION_RETENTION_DAYS` overrides it.",
				default: SETTINGS_DEFAULTS.retention.sessionDays,
			}),
		),
	},
	{
		description:
			"How long cleanup keeps data; one global policy for every project, so a project settings file cannot set it.",
		additionalProperties: false,
	},
);
