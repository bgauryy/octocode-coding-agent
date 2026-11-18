/**
 * The channel (`api.channels`) on which the team announces the transitions of an agent that this process itself wrote: the team
 * domain emits, the hooks domain turns `on` and `off` into the AgentOn and AgentOff hooks. Neither imports the other.
 */
export const AGENT_LIFECYCLE_CHANNEL = "octocode:agent-lifecycle";

/** What a listener on `AGENT_LIFECYCLE_CHANNEL` receives (the team's `LifecycleEvent`, as far as the listener reads it). */
export interface AgentLifecycleNotice {
	/** The `agent_events` sequence of the transition. */
	seq: number;
	/** `on`: the agent joined; `off`: its row was retired; `state`: its record changed (`stalled`, a new goal, …). */
	kind: "on" | "state" | "off";
	agent: string;
	role?: string;
	parent: string | null;
	registrationId?: string;
	time: string;
	/** `off` only: one of completed, failed, stopped-user, stopped-parent, parent-gone, crashed, left. */
	reason?: string;
	detail?: string;
	/** `off` only: the row's final numbers (`toolCalls`, `input`, `cacheRead`, `output`, `cost`, `startedAt`, `joinedAt`, `pid`, …). */
	stats?: Record<string, unknown>;
	/** The stored payload (`model`, `goal`, …). */
	data: Record<string, unknown>;
}
