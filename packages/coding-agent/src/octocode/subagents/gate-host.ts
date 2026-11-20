import { jobs } from "../../../../db/src/api.ts";
import type { FeatureSetup } from "../../core/features/index.ts";
import { sharedAgentDb } from "../../storage/database.ts";
import { jobStandingOf } from "../shared/job-standing.ts";
import { readRunLockSnap } from "../graph/run-lock.ts";
import type { Item } from "../backlog/item.ts";
import { AGENT_LIFECYCLE_CHANNEL, type AgentLifecycleNotice } from "../shared/agent-lifecycle.ts";
import type { DatabaseFollower } from "../shared/database-follower.ts";
import { watchRunLock } from "../shared/run-lock-watch.ts";
import type { GateHost } from "./prerequisites.ts";

/** What the host reads to settle prerequisites. */
export interface GateSources {
	api: Pick<FeatureSetup, "channels">;
	follower: DatabaseFollower;
	/** The backlog item `ref`, if the session has a backlog and the item exists. */
	item(ref: string): Pick<Item, "state" | "closed"> | undefined;
	/** This session's id: its background jobs are the ones `job:` names. */
	session(): string | undefined;
}

/** The gate's view of the session: items from the backlog, agents from the lifecycle channel, jobs and locks from the host. */
export function gateHost({ api, follower, item, session }: GateSources): GateHost {
	return {
		item: (ref) => {
			const found = item(ref);
			return !found ? "missing" : found.state !== "done" ? "open" : found.closed ? "closed" : "done";
		},
		lifecycle: (listener) =>
			api.channels.on(AGENT_LIFECYCLE_CHANNEL, (value) => listener(value as AgentLifecycleNotice)),
		follow: (poke) => follower.subscribe(poke),
		job: (id) => {
			const own = session();
			return jobStandingOf(own ? jobs.bySessionJob(sharedAgentDb().db, own, id) : undefined);
		},
		lockHeld: () => readRunLockSnap() !== undefined,
		watchLocks: watchRunLock,
	};
}
