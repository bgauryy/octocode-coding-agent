import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/**
 * The `subagents` settings: opt-in limits, off when absent, whose one reader is `spawnRefusal`
 * (octocode/subagents/spawn-limits.ts), and the check-in, whose one reader is `checkInConfig` (octocode/team/check-in.ts).
 */
export const SubagentSettingsSchema = Type.Object(
	{
		maxChildren: Type.Optional(
			Type.Integer({
				minimum: 1,
				description:
					"Subagents one session may start; a resume of a child it started is no new one. Past it a new spawn is refused with the total; what runs keeps running.",
			}),
		),
		maxCost: Type.Optional(
			Type.Number({
				exclusiveMinimum: 0,
				description:
					"US dollars of recorded spend, the session's own and its subagents', past which a new spawn is refused with the total; what runs keeps running.",
			}),
		),
		checkInSeconds: Type.Optional(
			Type.Number({
				minimum: 0,
				description:
					"Seconds a running subagent and its parent may go without a message before the subagent's own harness asks it whether it needs something. The ping joins a request the subagent was about to make; the parent's model is not called, and nothing is stopped. 0 turns it off.",
				default: SETTINGS_DEFAULTS.subagents.checkInSeconds,
			}),
		),
	},
	{
		description: "Limits on the subagents a session starts, and how they are checked on.",
		additionalProperties: false,
	},
);
