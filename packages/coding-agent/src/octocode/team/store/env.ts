export const AGENT_ID_ENV = "OCTOCODE_AGENT_ID";
export const PARENT_ID_ENV = "OCTOCODE_PARENT_ID";
export { PARENT_PID_ENV } from "../../../../../common/src/env.ts";
/** Set in a subagent: the role it was started with (its profile), shown next to its name. */
export const AGENT_ROLE_ENV = "OCTOCODE_AGENT_ROLE";
/** Set in a subagent: its goal, at most five words (`identity.ts`). Stored in the `task` column. */
export const AGENT_GOAL_ENV = "OCTOCODE_AGENT_GOAL";
/** Set in a foreground subagent: its parent is blocked in the `agent` call and reads its messages only with its report. */
export const PARENT_WAITS_ENV = "OCTOCODE_PARENT_WAITS";
