export const AGENT_ID_ENV = "OCTOCODE_AGENT_ID";
export const PARENT_ID_ENV = "OCTOCODE_PARENT_ID";
/** Set in a subagent: its parent Octocode's pid. The child leaves and shuts down when that process is gone (a crashed parent). */
export const PARENT_PID_ENV = "OCTOCODE_PARENT_PID";
/** Set in a subagent: the role it was started with (its profile), shown next to its name. */
export const AGENT_ROLE_ENV = "OCTOCODE_AGENT_ROLE";
/** Set in a subagent: its goal, at most five words (`identity.ts`). Stored in the `task` column. */
export const AGENT_GOAL_ENV = "OCTOCODE_AGENT_GOAL";
/** Set in a subagent started with `collaborate`: it works with its sibling subagents, not only for its parent. */
export const AGENT_COLLABORATE_ENV = "OCTOCODE_AGENT_COLLABORATE";
/** A subagent's own handoff folder (`<workspace>/.octocode/tmp/agents/<id>`): long results go there as files, not into its report. */
export const AGENT_SCRATCH_ENV = "OCTOCODE_AGENT_SCRATCH";
/** Absolute path used as-is as the team workspace (e.g. a subagent in a git worktree joins its parent's team). */
export const TEAM_WORKSPACE_ENV = "OCTOCODE_TEAM_WORKSPACE";
