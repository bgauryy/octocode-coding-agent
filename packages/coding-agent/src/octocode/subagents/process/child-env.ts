import { PROMPT_CACHE_KEY_ENV } from "@octocodeai/octocode-ai/utils/cache-policy";
import { ROLE_PROMPT_FILE_ENV } from "../../instructions/role.ts";
import {
	AGENT_SCRATCH_ENV,
	BACKLOG_ITEM_ENV,
	LEAN_ENV,
	MCP_SESSION_SERVERS_FILE_ENV,
	MCP_DEFER_ROLES_ENV,
	MCP_RECENT_TOOLS_ENV,
	PARENT_SESSION_ENV,
	PARENT_TRANSCRIPT_ENV,
	PERMISSION_GRANTS_ENV,
	PERMISSION_NONCE_FILE_ENV,
	PERMISSION_RELAY_ENV,
	READ_ONLY_ENV,
	SKILL_SNAPSHOT_FILE_ENV,
	SKILLS_IN_TASK_ENV,
	SUBAGENT_ENV,
	SUBAGENT_HOOKS_ENV,
	TEAM_WORKSPACE_ENV,
} from "@octocodeai/octocode-common/env";
import { PROMPT_ROOT_ENV, WORKTREE_ROOT_ENV } from "../../worktree-paths/prompt-root.ts";
import { processAlive } from "../../shared/process.ts";
import { SHELL_GROUPS_FILE_ENV } from "../../shared/shell-groups.ts";
import {
	AGENT_GOAL_ENV,
	AGENT_ID_ENV,
	AGENT_ROLE_ENV,
	PARENT_ID_ENV,
	PARENT_PID_ENV,
	PARENT_HOLDS_LEASES_ENV,
	PARENT_WAITS_ENV,
} from "../../team/store/env.ts";
import { SUBAGENT_ASSIGNMENT_ENV } from "../identity-reminder.ts";

/**
 * What a parent sets for one child run: its identity in the team, the role and task handoff files, and the limits the
 * run is bound by. `subagentProcessEnv` clears them from the environment a child starts from before setting its own, and
 * a process that finds them without being that child (`dropForeignChildEnv`) clears them to start as a top-level session.
 * The permission mode (`OCTOCODE_PERMISSION`) is left out on purpose: it is also a user setting, and what a child
 * inherited only makes a nested session stricter. A read-only role's reach is not inherited, so that role may not start
 * any `octocode` run (the product starts a session of its own; `shell/mutation.ts`), and how
 * deep the chain is stays counted (`NESTING_ENV`).
 */
export const CHILD_OWNED_ENV: readonly string[] = [
	SUBAGENT_ENV,
	PROMPT_CACHE_KEY_ENV,
	ROLE_PROMPT_FILE_ENV,
	SKILL_SNAPSHOT_FILE_ENV,
	MCP_SESSION_SERVERS_FILE_ENV,
	MCP_DEFER_ROLES_ENV,
	MCP_RECENT_TOOLS_ENV,
	SUBAGENT_HOOKS_ENV,
	READ_ONLY_ENV,
	LEAN_ENV,
	SKILLS_IN_TASK_ENV,
	PERMISSION_GRANTS_ENV,
	PERMISSION_NONCE_FILE_ENV,
	PERMISSION_RELAY_ENV,
	WORKTREE_ROOT_ENV,
	PROMPT_ROOT_ENV,
	TEAM_WORKSPACE_ENV,
	AGENT_ID_ENV,
	AGENT_ROLE_ENV,
	PARENT_ID_ENV,
	PARENT_WAITS_ENV,
	PARENT_HOLDS_LEASES_ENV,
	AGENT_GOAL_ENV,
	AGENT_SCRATCH_ENV,
	PARENT_SESSION_ENV,
	PARENT_TRANSCRIPT_ENV,
	PARENT_PID_ENV,
	BACKLOG_ITEM_ENV,
	SUBAGENT_ASSIGNMENT_ENV,
	SHELL_GROUPS_FILE_ENV,
];

/**
 * How many `agent` tasks stand above this process, across any `octocode` a child's shell started in between. Not in
 * `CHILD_OWNED_ENV`, on purpose: a nested session clears the rest and runs as top-level, with its own slots and no budget
 * from above, so this is what still counts the chain.
 */
export const NESTING_ENV = "OCTOCODE_AGENT_NESTING";
/** How deep a task may start: a child, and a child of the one session that child's shell may start. */
const MAX_NESTING = 2;

export const nestingOf = (env: NodeJS.ProcessEnv): number => {
	const depth = Number(env[NESTING_ENV]);
	return Number.isInteger(depth) && depth > 0 ? depth : 0;
};

/** Why this process may not start another task, when the chain above it is at the limit. */
export function nestingRefusal(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const depth = nestingOf(env);
	return depth < MAX_NESTING
		? undefined
		: `Refused: this session runs ${depth} agent tasks deep (a task's shell started it), the most that may start another. Do the work here, or report what you need to the session that started you.`;
}

/**
 * A child names the Octocode that started it in `OCTOCODE_PARENT_PID` (`<pid> <start time>`), and that process starts it
 * directly. An Octocode that a child's command starts inherits these variables with its parent being a shell, so it
 * would report the child's team name as held, run its role prompt and hide commands meant for top-level sessions. This
 * clears them from `env` when the named parent is alive but is not this process's parent, so the process is a top-level
 * session; scripts keep the documented session variables (`OCTOCODE_SESSION_ID`…), which are never child-owned.
 * Nothing is cleared when no parent is named (a harness sets the markers itself) or the named parent is gone (the child's
 * own parent check then ends it). Returns whether it cleared them.
 */
export function dropForeignChildEnv(
	env: NodeJS.ProcessEnv = process.env,
	ppid: number = process.ppid,
	alive: (pid: number) => boolean = processAlive,
): boolean {
	const named = Number(env[PARENT_PID_ENV]?.trim().split(" ")[0]);
	if (!Number.isInteger(named) || named <= 0 || named === ppid || !alive(named)) return false;
	for (const key of CHILD_OWNED_ENV) delete env[key];
	return true;
}
