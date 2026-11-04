import type { Member } from "@octocodeai/octocode-contracts/team";
import { STALLED_LISTED_MS } from "./limits.ts";
import {
	type AgentDb,
	type AgentRun,
	type ResolvedAgent,
	type RunOutcome,
	type RunStart,
	agentEvents,
	agentRuns,
	agents,
	type Db,
	resolveAgent,
} from "../../../../../db/src/api.ts";

/** The presence side of the agent database as the lifecycle needs it: the event cursor, this connection's own writes, and the parent's end hint. */
export class Presence {
	private readonly agent: AgentDb;
	private readonly db: Db;

	constructor(agent: AgentDb) {
		this.agent = agent;
		this.db = agent.db;
	}

	/** The newest presence event now. */
	head = (): number => agentEvents.head(this.db);

	/** Presence events after `after`, oldest first. */
	since = (after: number): agentEvents.EventRow[] => agentEvents.since(this.db, after);

	/** Calls `listener` with the sequences each transaction of this connection appended; the returned function stops it. */
	onWrite = (listener: (from: number, to: number) => void): (() => void) => this.agent.onEvents(listener);

	/** Leaves `hint` on the row of child `id`, in its own transaction: whoever retires the row names that reason; whether a row took it. */
	hint(id: string, hint: agentEvents.EndReason): boolean {
		return this.agent.transaction(() => agents.setEndHint(this.db, id, hint));
	}

	/**
	 * `stalled` update events for the members that run but have been silent for `STALLED_LISTED_MS`: one per episode, whichever
	 * process notices first (`agents.noteState` keys it by the heartbeat the silence began at), and none when nothing is silent.
	 */
	noteStalled(silent: readonly Member[], now: number): void {
		const long = silent.filter((member) => now - member.updatedAt >= STALLED_LISTED_MS);
		if (long.length > 0)
			this.agent.transaction(() => long.forEach((m) => agents.noteState(this.db, m.id, "stalled", now)));
	}

	/** The parent starts child `start.agentId`: its run opens in this workspace. Returns the run id. */
	beginRun = (start: Omit<RunStart, "workspaceId">, workspaceId: string): string =>
		this.agent.transaction(() => agentRuns.begin(this.db, { ...start, workspaceId }));

	/** The parent's word on the latest run of `agentId` (`agentRuns.finish`); whether a run took it. */
	finishRun = (agentId: string, outcome: RunOutcome): boolean =>
		this.agent.transaction(() => agentRuns.finish(this.db, agentId, outcome));

	/** The runs that began last, newest first. */
	runs = (filter: { workspaceId?: string; agentId?: string; limit?: number } = {}): AgentRun[] =>
		agentRuns.recent(this.db, filter);

	/** The runs started for backlog item `seq` of `workspaceId`, newest first. */
	runsForItem = (workspaceId: string, seq: number): AgentRun[] => agentRuns.forItem(this.db, workspaceId, seq);

	/** The agent `ref` names, live or past (`resolveAgent`), read from `workspaceId`. */
	resolve = (ref: string, workspaceId: string): ResolvedAgent | undefined => resolveAgent(this.db, ref, workspaceId);
}
