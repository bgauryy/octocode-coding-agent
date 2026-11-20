import { Type, type Static } from "typebox";

const count = Type.Integer({ minimum: 0, maximum: 100000 });
const refs = Type.Array(Type.String({ maxLength: 64 }), { maxItems: 50 });

/**
 * What a session is doing from the user's side, derived by the host from its run, dialogs, running work, pending wakes
 * and held backlog items. `blocked`, `working`, `waiting`, `resuming` and `scheduled` are not final: the session is
 * running, or something will start it again without the user. `stopped`, `failed`, `done` and `idle` are terminal.
 * Every string is redacted and bounded by the host.
 */
export const ApplicationPhaseSchema = Type.Union([
	Type.Object({ state: Type.Literal("blocked"), title: Type.String({ maxLength: 200 }) }),
	Type.Object({ state: Type.Literal("working"), activity: Type.Optional(Type.String({ maxLength: 200 })) }),
	Type.Object({
		state: Type.Literal("waiting"),
		agents: count,
		queued: count,
		bash: count,
		external: count,
		/** The agents and bash jobs behind the counts, as short names. */
		names: Type.Optional(
			Type.Object({
				agents: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 50 }),
				bash: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 50 }),
			}),
		),
	}),
	Type.Object({ state: Type.Literal("resuming"), label: Type.Optional(Type.String({ maxLength: 200 })) }),
	Type.Object({
		state: Type.Literal("scheduled"),
		timers: Type.Integer({ minimum: 1, maximum: 100000 }),
		id: Type.String({ maxLength: 64 }),
		/** When the earliest timer that has a due time fires (ms since the epoch). */
		dueAt: Type.Optional(Type.Number()),
		/** What the earliest timer waits for: its note's first line or its condition. */
		label: Type.Optional(Type.String({ maxLength: 200 })),
	}),
	Type.Object({ state: Type.Literal("stopped"), open: refs }),
	Type.Object({ state: Type.Literal("failed"), error: Type.String({ maxLength: 300 }), open: Type.Optional(refs) }),
	Type.Object({ state: Type.Literal("done") }),
	Type.Object({ state: Type.Literal("idle") }),
]);
export type ApplicationPhase = Static<typeof ApplicationPhaseSchema>;

/** Nothing runs, nothing is due and nothing will start a turn: the job is over. */
export function isTerminalApplicationPhase(phase: ApplicationPhase): boolean {
	return phase.state === "stopped" || phase.state === "failed" || phase.state === "done" || phase.state === "idle";
}

/** No run is active but work or a wake will continue the job: indicators of progress stay on. */
export function isPendingApplicationPhase(phase: ApplicationPhase): boolean {
	return phase.state === "waiting" || phase.state === "resuming" || phase.state === "scheduled";
}

/** What the session is doing besides running: compacting, waiting for a retry, or a model request that sends nothing. */
export const SessionStatusSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("compacting"),
	Type.Literal("retrying"),
	Type.Literal("stalled"),
]);

export const SessionStatusEventSchema = Type.Object({
	type: Type.Literal("session.status"),
	status: SessionStatusSchema,
	/** One line on why the status is not idle: how long the model has been quiet, or which retry comes. */
	detail: Type.Optional(Type.String()),
	/** When the status ends on its own (ms since the epoch): the start of a retry's attempt, for a countdown. */
	until: Type.Optional(Type.Number()),
});
