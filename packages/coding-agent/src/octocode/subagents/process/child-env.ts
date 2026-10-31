import { PROMPT_CACHE_KEY_ENV } from "@octocodeai/octocode-ai/utils/cache-policy";
import { ROLE_PROMPT_FILE_ENV } from "../../instructions/role.ts";
import {
	AGENT_SCRATCH_ENV,
	BACKLOG_ITEM_ENV,
	BROWSER_VISIBLE_ENV,
	LEAN_ENV,
	MCP_SESSION_SERVERS_FILE_ENV,
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
	TRUST_ROOT_ENV,
} from "../../../../../common/src/env.ts";
import { PROMPT_ROOT_ENV, WORKTREE_ROOT_ENV } from "../../shared/prompt-root.ts";
import { processAlive } from "../../shared/process.ts";
import { AGENT_GOAL_ENV, AGENT_ID_ENV, AGENT_ROLE_ENV, PARENT_ID_ENV, PARENT_PID_ENV } from "../../team/store/env.ts";

/**
 * What a parent sets for one child run: its identity in the team, the role and task handoff files, and the limits the
 * run is bound by. `subagentProcessEnv` clears them from the environment a child starts from before setting its own, and
 * a process that finds them without being that child (`dropForeignChildEnv`) clears them to start as a top-level session.
 * The permission mode (`OCTOCODE_PERMISSION`) is left out on purpose: it is also a user setting, and what a child
 * inherited only makes a nested session stricter.
 */
export const CHILD_OWNED_ENV: readonly string[] = [
	SUBAGENT_ENV,
	PROMPT_CACHE_KEY_ENV,
	ROLE_PROMPT_FILE_ENV,
	SKILL_SNAPSHOT_FILE_ENV,
	MCP_SESSION_SERVERS_FILE_ENV,
	SUBAGENT_HOOKS_ENV,
	READ_ONLY_ENV,
	LEAN_ENV,
	SKILLS_IN_TASK_ENV,
	TRUST_ROOT_ENV,
	BROWSER_VISIBLE_ENV,
	PERMISSION_GRANTS_ENV,
	PERMISSION_NONCE_FILE_ENV,
	PERMISSION_RELAY_ENV,
	WORKTREE_ROOT_ENV,
	PROMPT_ROOT_ENV,
	TEAM_WORKSPACE_ENV,
	AGENT_ID_ENV,
	AGENT_ROLE_ENV,
	PARENT_ID_ENV,
	AGENT_GOAL_ENV,
	AGENT_SCRATCH_ENV,
	PARENT_SESSION_ENV,
	PARENT_TRANSCRIPT_ENV,
	PARENT_PID_ENV,
	BACKLOG_ITEM_ENV,
];

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
