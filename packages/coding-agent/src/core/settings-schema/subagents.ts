import { Type } from "typebox";
import { SETTINGS_DEFAULTS } from "../settings-defaults.ts";

/**
 * The `subagents` settings: opt-in limits, off when absent, whose one reader is `spawnRefusal`
 * (octocode/subagents/spawn-limits.ts), and the deprecated check-in and silence keys, read by the monitor
 * (octocode/monitor/attention/) only when the `monitor.*` key is unset.
 */
export const SubagentSettingsSchema = Type.Object(
	{
		models: Type.Optional(
			Type.Object(
				{
					small: Type.Optional(Type.String({ minLength: 1 })),
					medium: Type.Optional(Type.String({ minLength: 1 })),
				},
				{
					description:
						'Model for the `small` and `medium` subagent purposes, each `provider/model` with an optional `:level` thinking suffix, e.g. { "small": "openai/gpt-5-mini:low" }. Used by every profile or task that names the purpose, before the automatic choice; a call\'s own `model` still wins. A model that is not available, cannot run a task or sits on a provider that refused its credential is skipped for the automatic choice, and the route says why. Read from the global settings file; a project file cannot set it.',
					additionalProperties: false,
				},
			),
		),
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
		queuedStarts: Type.Optional(
			Type.Boolean({
				description:
					"Let a background `agent` task wait for prerequisites instead of being refused: its `after` list (backlog items `B<n>`, children `agent:<name>`) and the open `dependsOn` of its item. A queued child holds no slot, reservation or item claim; it starts when the last prerequisite ends well, and is held (the coordinator is told) when one fails. Off: such a task is refused as before.",
				default: true,
			}),
		),
		checkInSeconds: Type.Optional(
			Type.Number({
				minimum: 0,
				description:
					"Deprecated: use monitor.checkInSeconds, which wins when both are set. Seconds a running subagent and its parent may go without a message before the subagent is asked whether it needs something; 0 turns it off.",
				default: SETTINGS_DEFAULTS.subagents.checkInSeconds,
			}),
		),
		silenceMinutes: Type.Optional(
			Type.Number({
				minimum: 0,
				description:
					"Deprecated: use monitor.idleAgentMinutes. Read only when monitor.idleAgentMinutes and monitor.silenceMinutes are unset: minutes a working agent may make no progress before the agent responsible for it is told; 0 turns it off.",
			}),
		),
		wakeHoldSeconds: Type.Optional(
			Type.Number({
				minimum: 0,
				maximum: 10,
				description:
					"Seconds an idle session holds a wake (a child's report, a job's exit, mail) so wakes arriving close together share one turn. The first wake opens the window; everything arriving in it is delivered together when it ends. 0 delivers each wake at once. Costs up to this much latency per wake.",
				default: SETTINGS_DEFAULTS.subagents.wakeHoldSeconds,
			}),
		),
		peerOverlapWake: Type.Optional(
			Type.Boolean({
				description:
					"Wake the holder of an ongoing item, or of a reservation, when another agent claims an item (or edits its paths) that overlaps its paths, once per pair. Off: the holder hears of it with its next turn instead.",
				default: SETTINGS_DEFAULTS.subagents.peerOverlapWake,
			}),
		),
		skillCatalog: Type.Optional(
			Type.Union([Type.Literal("all"), Type.Literal("role")], {
				description:
					"Which skills a subagent started without named skills can load. all: this session's whole skill catalog. role: only its role's skills, so the child prompt drops the catalog; skills the task names are always listed.",
				default: SETTINGS_DEFAULTS.subagents.skillCatalog,
			}),
		),
	},
	{
		description: "Limits on the subagents a session starts, and how they are checked on.",
		additionalProperties: false,
	},
);
