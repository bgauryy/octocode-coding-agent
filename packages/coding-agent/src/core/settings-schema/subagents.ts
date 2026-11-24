import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/**
 * The `subagents` settings: opt-in limits, off when absent, whose one reader is `spawnRefusal`
 * (octocode/subagents/spawn-limits.ts).
 */
export const SubagentSettingsSchema = Type.Object(
	{
		models: Type.Optional(
			Type.Object(
				{
					small: Type.Optional(Type.String({ minLength: 1 })),
					medium: Type.Optional(Type.String({ minLength: 1 })),
					large: Type.Optional(Type.String({ minLength: 1 })),
				},
				{
					description:
						'Model for the `small`, `medium` and `large` subagent purposes, each `provider/model` with an optional `:level` thinking suffix, e.g. { "small": "openai/gpt-5-mini:low" }. Used by every profile or task that names the purpose, before the automatic choice; a call\'s own `model` still wins. A model that is not available, cannot run a task or sits on a provider that refused its credential is skipped for the automatic choice, and the route says why. Read from the global settings file; a project file cannot set it.',
					additionalProperties: false,
				},
			),
		),
		maxChildren: Type.Optional(
			Type.Integer({
				minimum: 1,
				description:
					"Subagents one session may start; a resume of a child it started is no new one. Past it a new spawn is refused with the total; what runs keeps running. You are told the first time it refuses, once per session for each value.",
			}),
		),
		maxCost: Type.Optional(
			Type.Number({
				exclusiveMinimum: 0,
				description:
					"US dollars billed per token, the session's own and its subagents' (a plan's share is an estimate, not money, and never counts), past which a new spawn, a resume and a message to a lingering subagent are refused with the total; what runs keeps running. You are told the first time it refuses, once per session for each value.",
			}),
		),
		queuedStarts: Type.Optional(
			Type.Boolean({
				description:
					"Let a background `agent` task wait for prerequisites instead of being refused: its `after` list (backlog items `B<n>`, children `agent:<name>`) and the open `dependsOn` of its item. A queued child holds no slot, reservation or item claim; it starts when the last prerequisite ends well, and is held (the coordinator is told) when one fails. Off: such a task is refused as before.",
				default: true,
			}),
		),
		peerOverlapWake: Type.Optional(
			Type.Boolean({
				description:
					"Wake the holder of an ongoing item, or of a reservation, when another agent claims an item (or edits its paths) that overlaps its paths, once per pair. Off: the holder hears of it with its next turn instead.",
				default: SETTINGS_DEFAULTS.subagents.peerOverlapWake,
			}),
		),
	},
	{
		description: "Limits on the subagents a session starts, and how they are checked on.",
		additionalProperties: false,
	},
);
