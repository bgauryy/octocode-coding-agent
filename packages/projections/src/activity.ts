import type {
	Activity,
	ActivityTone,
	ApplicationPhase,
	ApplicationSnapshot,
	UiState,
} from "@octocodeai/octocode-contracts";

/**
 * What an agent or a session is doing, as its light shows it (the contracts' `ActivitySchema`, so a session list can carry
 * it): `working` (green: a run, compaction, a retry, background work or a wake), `waiting` (yellow: a dialog or question
 * waits for the user), `error` (red: the job failed or stopped with work left open) and `idle` (dim: nothing runs; done,
 * or a timer that will wake it). `state` is the design state whose mark draws the light, so a surface without colour still
 * shows a distinct shape; `label` is the one or two words printed beside it: the light is never the only cue.
 */
export type { Activity, ActivityTone };

/**
 * The facts a light reads: an application snapshot's (the terminal reads the same fields from its application state),
 * or the part of them a session list knows. `awaiting` is the open dialog, or `true` from a list that knows only that one
 * waits.
 */
export interface ActivityFacts {
	readonly awaiting?: ApplicationSnapshot["awaiting"] | boolean;
	readonly streaming?: boolean;
	readonly status?: ApplicationSnapshot["status"];
	readonly phase?: ApplicationPhase;
}

/** The mark of each tone: the state light draws these states' shapes. */
export const ACTIVITY_STATE = {
	working: "running",
	waiting: "waiting",
	error: "failed",
	idle: "pending",
} as const satisfies Readonly<Record<ActivityTone, UiState>>;

const of = (tone: ActivityTone, label: string): Activity => ({ tone, state: ACTIVITY_STATE[tone], label });

/** The words of a phase no run of the session's own shows; `blocked` and `working` are decided before. */
const PHASE: Record<Exclude<ApplicationPhase["state"], "blocked" | "working">, Activity> = {
	waiting: of("working", "background"),
	resuming: of("working", "resuming"),
	scheduled: of("idle", "scheduled"),
	failed: of("error", "failed"),
	stopped: of("error", "stopped"),
	done: of("idle", "done"),
	idle: of("idle", "idle"),
};

/**
 * The one answer to "what is it doing?" that every light reads: the footer, the agents panel's root, the session lists
 * and the web header. The user's attention comes first (a dialog that waits), then work outside a run (compaction, a
 * retry, a quiet model), then the run itself, then what the phase says once no run is active.
 */
export function activity(facts: ActivityFacts | undefined): Activity {
	if (facts?.awaiting || facts?.phase?.state === "blocked") return of("waiting", "needs you");
	if (facts?.status === "compacting") return of("working", "compacting");
	if (facts?.status === "retrying") return of("working", "retrying");
	if (facts?.status === "stalled") return of("working", "not answering");
	if (facts?.streaming || facts?.phase?.state === "working") return of("working", "working");
	return facts?.phase ? { ...PHASE[facts.phase.state] } : of("idle", "idle");
}
