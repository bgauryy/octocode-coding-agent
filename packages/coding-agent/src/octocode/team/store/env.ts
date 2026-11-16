export { AGENT_ID_ENV, AGENT_ROLE_ENV, PARENT_ID_ENV, PARENT_PID_ENV } from "../../../../../common/src/env.ts";
/** Set in a subagent: its goal, at most five words (`identity.ts`). Stored in the `task` column. */
export const AGENT_GOAL_ENV = "OCTOCODE_AGENT_GOAL";
/** Set in a foreground subagent: its parent is blocked in the `agent` call and reads its messages only with its report. */
export const PARENT_WAITS_ENV = "OCTOCODE_PARENT_WAITS";
/** Set in a subagent whose parent reserved paths for it (`ChildLeases`): when its run settles the parent keeps them until the run ends. */
export const PARENT_HOLDS_LEASES_ENV = "OCTOCODE_PARENT_HOLDS_LEASES";
