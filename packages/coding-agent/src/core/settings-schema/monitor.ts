import { Type } from "typebox";

/** The threshold monitor's defaults: what `monitor.*` falls back to. */
export const MONITOR_DEFAULTS = {
	enabled: true,
	sampleSeconds: 60,
	samples: 3,
	cooldownMinutes: 15,
	loadPerCore: 3,
	memoryAvailablePercent: 10,
	swapPercent: 90,
	gpuPercent: 95,
	stuckJobMinutes: 15,
	contextBands: [0.5, 0.75, 0.9] as readonly number[],
	checkInSeconds: 300,
	idleAgentMinutes: 5,
} as const;

const number = (description: string, value: number, minimum: number, maximum?: number) =>
	Type.Optional(Type.Number({ description, default: value, minimum, ...(maximum === undefined ? {} : { maximum }) }));

/** The `monitor` settings of the root schema. */
export const MonitorSettingsProperties = {
	monitor: Type.Optional(
		Type.Object(
			{
				enabled: Type.Optional(
					Type.Boolean({
						description:
							"Sample the machine (load, memory, swap, GPU, busiest processes) once per interval and tell the session whose processes cause a tripped threshold. One Octocode process per machine takes the samples; every session reads them.",
						default: MONITOR_DEFAULTS.enabled,
					}),
				),
				sampleSeconds: number("Seconds between machine samples.", MONITOR_DEFAULTS.sampleSeconds, 10, 3600),
				samples: number(
					"Consecutive samples over a threshold before it alerts, so a short spike does not.",
					MONITOR_DEFAULTS.samples,
					1,
					60,
				),
				cooldownMinutes: number("Minutes before the same threshold alerts again.", MONITOR_DEFAULTS.cooldownMinutes, 0),
				loadPerCore: number(
					"Alert when the 1-minute load average per logical CPU reaches this (0 turns it off).",
					MONITOR_DEFAULTS.loadPerCore,
					0,
				),
				memoryAvailablePercent: number(
					"Alert when the memory the system can still hand out falls to this percentage of the total (0 turns it off).",
					MONITOR_DEFAULTS.memoryAvailablePercent,
					0,
					100,
				),
				swapPercent: number(
					"Alert when used swap reaches this percentage of the swap in place (above 100 turns it off).",
					MONITOR_DEFAULTS.swapPercent,
					0,
				),
				gpuPercent: number(
					"Alert when GPU utilization reaches this percentage (above 100 turns it off).",
					MONITOR_DEFAULTS.gpuPercent,
					0,
				),
				stuckJobMinutes: number(
					"Tell the session when one of its background bash jobs has written no output and used almost no CPU for this many minutes (0 turns it off).",
					MONITOR_DEFAULTS.stuckJobMinutes,
					0,
				),
				contextBands: Type.Optional(
					Type.Array(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1 }), {
						description:
							"Shares of the room before automatic compaction at which the model is told, once each, how much context it has used and how much is left. Each is above 0 and below 1; [] turns the notices off.",
						default: [...MONITOR_DEFAULTS.contextBands],
					}),
				),
				checkInSeconds: number(
					"Seconds a running subagent and its parent may go without a message before the subagent's own harness asks it whether it needs something. The ping joins a request the subagent was about to make; the parent's model is not called, and nothing is stopped. 0 turns it off.",
					MONITOR_DEFAULTS.checkInSeconds,
					0,
				),
				idleAgentMinutes: number(
					"Minutes a working agent may make no progress (no model reply or tool event) before the agent responsible for it is told, once per silence: a subagent's parent, or a main session itself (a note and a footer mark). Checked once a minute; an agent waiting on the user, its children or its jobs is excused, and nothing is stopped. 0 turns it off.",
					MONITOR_DEFAULTS.idleAgentMinutes,
					0,
				),
				silenceMinutes: Type.Optional(
					Type.Number({
						minimum: 0,
						description:
							"Deprecated: use monitor.idleAgentMinutes, which wins when both are set. Read in its place when it is unset; 0 turns the rule off.",
					}),
				),
			},
			{ additionalProperties: false },
		),
	),
};
