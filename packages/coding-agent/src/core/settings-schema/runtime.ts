import { Type } from "typebox";

/** `runtime.eventLoop`: the scheduler that decides when events and typed input start a turn. */
export type EventLoopMode = "old" | "shadow" | "new";

/** What `runtime.*` falls back to; `eventLoop` stays `old` until the loop owns every path. */
export const RUNTIME_DEFAULTS = {
	eventLoop: "old" as EventLoopMode,
	eventWindowSeconds: 2,
} as const;

/** The `runtime` settings of the root schema. */
export const RuntimeSettingsProperties = {
	runtime: Type.Optional(
		Type.Object(
			{
				eventLoop: Type.Optional(
					Type.Union([Type.Literal("old"), Type.Literal("shadow"), Type.Literal("new")], {
						description:
							"Which scheduler starts turns from background events. `old` (default): the wake gate, unchanged. `shadow`: the event loop runs beside the gate, decides which events would wake the session and in what order, acts on nothing, and records each difference from the gate as a problem (`/status`). `new`: the loop delivers the events it has taken over (a background `bash` job's exit, a child's report or end, and team mail, with the `runtime.eventWindowSeconds` window) and the gate the rest, which behave as in `shadow`. Reports and mail the loop has queued survive a restart or resume and are delivered once. Read at session start.",
						default: RUNTIME_DEFAULTS.eventLoop,
					}),
				),
				eventWindowSeconds: Type.Optional(
					Type.Number({
						description:
							"Seconds the event loop waits after a background event wakes an idle session, so events that arrive together become one message and one turn. User input is never held. Applies to the events the loop delivers (`runtime.eventLoop: new`: a background job's exit, a child's report or end, team mail); the wake gate keeps `subagents.wakeHoldSeconds` for the rest.",
						default: RUNTIME_DEFAULTS.eventWindowSeconds,
						minimum: 0,
						maximum: 10,
					}),
				),
			},
			{ additionalProperties: false },
		),
	),
};
