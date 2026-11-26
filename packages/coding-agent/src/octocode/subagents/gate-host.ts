import { type AgentDb, dbStamp, isBusy, jobs } from "../../../../db/src/api.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import type { FeatureSetup } from "../../core/features/index.ts";
import { jobStandingOf } from "../shared/job-standing.ts";
import { readRunLockSnap } from "../graph/run-lock.ts";
import type { Item } from "../backlog/item.ts";
import { AGENT_LIFECYCLE_CHANNEL, type AgentLifecycleNotice } from "../shared/agent-lifecycle.ts";
import { DatabaseFollower } from "../shared/database-follower.ts";
import { watchRunLock } from "../shared/run-lock-watch.ts";
import type { GateHost } from "./prerequisites.ts";

/** What the host reads to settle prerequisites. */
export interface GateSources {
	api: Pick<FeatureSetup, "channels">;
	follower: DatabaseFollower;
	/** The session's backlog, if it has one: its items, and its file holds the session's job rows. */
	board(): { store: { agent: AgentDb; get(ref: string): Pick<Item, "state" | "closed"> | undefined } } | undefined;
	/** This session's id: its background jobs are the ones `job:` names. */
	session(): string | undefined;
	/** Whether `id` is a child of this session still finalizing its report. */
	ownRunning?(id: string): boolean;
}

/** Follows writes to the file of the session's board, jobs and runs: its workspace's, the machine file before a session. */
export function boardFollower(board: GateSources["board"]): DatabaseFollower {
	return new DatabaseFollower(() => dbStamp((board()?.store.agent ?? sharedAgentDb()).file), isBusy);
}

/** The gate's view of the session: items from the backlog, agents from the lifecycle channel, jobs and locks from the host. */
export function gateHost({ api, follower, board, session, ownRunning }: GateSources): GateHost {
	return {
		item: (ref) => {
			const found = board()?.store.get(ref);
			return !found ? "missing" : found.state !== "done" ? "open" : found.closed ? "closed" : "done";
		},
		...(ownRunning ? { ownRunning } : {}),
		lifecycle: (listener) =>
			api.channels.on(AGENT_LIFECYCLE_CHANNEL, (value) => listener(value as AgentLifecycleNotice)),
		follow: (poke) => follower.subscribe(poke),
		job: (id) => {
			const own = session();
			const agent = own && board()?.store.agent;
			return jobStandingOf(agent && own ? jobs.bySessionJob(agent.db, own, id) : undefined);
		},
		lockHeld: () => readRunLockSnap() !== undefined,
		watchLocks: watchRunLock,
	};
}
