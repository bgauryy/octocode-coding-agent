import type { FeatureContext, FeatureSetup } from "../../core/features/index.ts";
import type { Permission } from "../permission/ask.ts";
import type { AgentRuns, Run } from "./claim.ts";
import type { Lingering } from "./linger.ts";
import type { ChildSession } from "./process/session.ts";
import type { AgentProfile } from "./profiles.ts";
import type { RelayHost } from "./relay.ts";
import type { RunDetails } from "./run-types.ts";
import type { Runners } from "./runner-port.ts";

/** What starting a subagent reads of the `agent` tool's registration (`tool.ts`). */
export interface SpawnEnv {
	api: FeatureSetup;
	runs: AgentRuns;
	permission: Permission;
	getProfiles: () => Map<string, AgentProfile>;
	getRefused?: () => ReadonlyMap<string, string>;
	lingering: Lingering;
	/** Live agent and goal pairs the launch result already named (`team/overlap.ts`): each is named once. */
	overlapWarned: Set<string>;
	/** The caller's signal joined with the one a permission change or shutdown aborts. */
	withLaunch: (signal?: AbortSignal) => AbortSignal;
	/** Runs `work` and, once it ends, records the run's session file and its questions to this session's agent. */
	record: <T>(run: Run, details: RunDetails, session: ChildSession, work: Promise<T>) => Promise<T>;
	relayHost: (ctx: Pick<FeatureContext, "hasUI" | "ui">) => RelayHost;
	/** Connected runners: a task with `runner` runs its turns there instead of in an Octocode child (`runner-child.ts`). */
	runners?: Runners;
}
