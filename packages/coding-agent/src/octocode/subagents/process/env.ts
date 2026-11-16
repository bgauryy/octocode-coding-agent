import type { McpServerConfig } from "@octocodeai/octocode-contracts/mcp-server";
import type { SkillResourceSnapshot } from "../../../core/skill-resource-snapshot.ts";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
	type CachePreferences,
	INSTRUCTION_CACHE_RETENTION_ENV,
	PROMPT_CACHE_KEY_ENV,
} from "@octocodeai/octocode-ai/utils/cache-policy";
import { ROLE_PROMPT_FILE_ENV } from "../../instructions/role.ts";
import type { ActionClass, PermissionMode } from "../../permission/mode.ts";
import {
	BACKLOG_ITEM_ENV,
	MCP_DEFER_ROLES_ENV,
	MCP_RECENT_TOOLS_ENV,
	CACHE_RETENTION_ENV,
	SUBAGENT_HOOKS_ENV,
	READ_ONLY_ENV,
	LEAN_ENV,
	MEMORY_AUTO_ENV,
	SKILLS_IN_TASK_ENV,
	MCP_SESSION_SERVERS_FILE_ENV,
	PARENT_SESSION_ENV,
	AGENT_RUN_ID_ENV,
	PARENT_TRANSCRIPT_ENV,
	PERMISSION_ENV,
	PERMISSION_GRANTS_ENV,
	PERMISSION_NONCE_FILE_ENV,
	PERMISSION_RELAY_ENV,
	SUBAGENT_ENV,
	SKILL_SNAPSHOT_FILE_ENV,
	AGENT_SCRATCH_ENV,
	TEAM_WORKSPACE_ENV,
} from "../../../../../common/src/env.ts";
import { outputDir } from "../../shared/home.ts";
import { childHookMode, type HookMode } from "../../shared/hook-mode.ts";
import { PROMPT_ROOT_ENV, WORKTREE_ROOT_ENV } from "../../worktree-paths/prompt-root.ts";
import { processStartTime } from "../../shared/process.ts";
import {
	AGENT_GOAL_ENV,
	AGENT_ID_ENV,
	AGENT_ROLE_ENV,
	PARENT_ID_ENV,
	PARENT_PID_ENV,
	PARENT_HOLDS_LEASES_ENV,
	PARENT_WAITS_ENV,
} from "../../team/store/env.ts";
import type { AgentProfile } from "../profiles.ts";
import { DEFAULT_MAX_REQUESTS } from "../budget.ts";
import type { ResultContract } from "../result-schema.ts";
import { CHILD_OWNED_ENV, NESTING_ENV, nestingOf } from "./child-env.ts";
import { SUBAGENT_ASSIGNMENT_ENV } from "../identity-reminder.ts";
import { PRIVATE_FILE_MODE } from "../../../../../common/src/file-mode.ts";

/** Asks the Anthropic API for its cache-miss reason (`ai/src/api/anthropic-messages/cache-diagnostics.ts`). */
const CACHE_DIAGNOSTICS_ENV = "OCTOCODE_CACHE_DIAGNOSTICS";

/** A task's cache tier for the child's conversation history: the provider's short tier, or the session's longest. */
export const CACHE_CHOICES = ["short", "long"] as const;
export type CacheChoice = (typeof CACHE_CHOICES)[number];

/** What decides a task's default cache tier: whether the child is expected to sit idle past the short window. */
export interface TaskShape {
	/** A finished run of it stays reachable for a follow-up message (`linger`: a background run that is not isolated). */
	lingers?: boolean;
	/** It continues an earlier run's saved conversation (`resume`): it was messaged after a pause and may be again. */
	resumed?: boolean;
	/** Its model thinking level (`low` in `p/m:low`), when the route names one. */
	thinking?: string;
	/** Its soft request limit (`budget.ts` `maxRequests`); 0 means none. */
	requests?: number;
}

const LONG_THINKING = new Set(["high", "xhigh", "max"]);

/**
 * The tier of a task that names none. `short` for a child that works without pauses: measured child requests follow
 * each other after 0 s at the median and 100 s at the 99th percentile, well inside the short window, and a long write
 * costs more (2x against 1.25x input on Anthropic, docs/prompt-caching.md). `long` when the child is expected to idle
 * past the short window and come back to its history: it lingers for a follow-up or is resumed (a message from its
 * coordinator or a peer), it thinks at `high` or above, or its request budget is off or above the default (a long
 * task). Running in the background or in a worktree says nothing about pauses; a coordinator that knows its child will
 * wait on a timer, a background job or a message sets `cache: "long"` on the task.
 */
export function defaultTaskCache(shape: TaskShape): CacheChoice {
	const longBudget = shape.requests !== undefined && (shape.requests === 0 || shape.requests > DEFAULT_MAX_REQUESTS);
	const long =
		shape.lingers === true || shape.resumed === true || LONG_THINKING.has(shape.thinking ?? "") || longBudget;
	return long ? "long" : "short";
}

/**
 * The retention a child starts with, from the policy resolved for its model. A retention the user configured (settings
 * file, provider or model entry, environment) reaches the child as resolved, whatever the task chose. Otherwise `choice`
 * (the task's `cache` field, else `defaultTaskCache`) sets the history tier alone: the instruction blocks keep the
 * session's tier in both cases, so siblings of a role that chose differently still write and read one instruction entry.
 */
export function childCachePreferences(
	policy: { options: CachePreferences; sources: Partial<Record<keyof CachePreferences, string>> },
	choice: CacheChoice,
): CachePreferences {
	if (policy.sources.cacheRetention !== "defaults" || choice === "long") return policy.options;
	return { cacheRetention: "short", instructionCacheRetention: policy.options.instructionCacheRetention };
}

/** The child's place in the team: its name (id), its role (profile), its goal, and the agent that started it. */
export interface Identity {
	resultContract?: ResultContract;
	skillResources?: SkillResourceSnapshot;
	/** MCP servers the parent's `mcp` tool added this session (the user confirmed them): the child registers them, and nothing is written to `mcp.json`. */
	mcpServers?: Readonly<Record<string, McpServerConfig>>;
	/** Servers the parent stopped for this session only: the child leaves them out unless its tool selection names them. */
	mcpStopped?: readonly string[];
	/** The MCP tools the parent counts as in use (`mcpExposure: "recent"`): the child defers the same ones, so both share a cached prefix. */
	mcpRecent?: readonly string[];
	/** The configured servers the task gave the child (`mcp` on the task, plus those its tools name): any other stays out. */
	mcpOnly?: readonly string[];
	/** The servers the task named: their tools are added to the child's selection, so a server that is not active by default still starts. */
	mcpNamed?: readonly string[];
	cachePreferences?: CachePreferences;
	/** How much of the user's hooks it runs (`childHookMode`); a follow-up to the same child keeps it. Absent: none. */
	hooks?: HookMode;
	/** Lifetime of the history entry the child's requests write, when known (`cache-warmer/economics`). */
	cacheTtlMs?: number;
	/** Siblings of its prefix save by waiting for its cache entry: its model prices a cache read below the write (`staggerPays`). */
	staggers?: boolean;
	/** Shared cache group; transport sessions remain unique to each child. */
	promptCacheKey?: string;
	/** The parent chose its skills: they ride in its task and its prompt lists none (`SKILLS_IN_TASK_ENV`). */
	skillsInTask?: boolean;
	id: string;
	/** Stable conversation ID, independent of the agent display name and individual run IDs. */
	sessionId?: string;
	role?: string;
	parentId?: string;
	/** A foreground run: its parent is blocked in the `agent` call and reads its messages only with its report. */
	parentWaits?: boolean;
	/** This run was resumed by a peer's message its parent's process relayed: no parent decided it, so it is no budget grant. */
	peerResumed?: boolean;
	goal?: string;
	/**
	 * Set for an isolated child. `path` is its worktree, `repo` the main checkout and `cwd` where it runs. Its system
	 * prompt names the main checkout, so every child of one profile shares the prompt; the task names the worktree.
	 */
	isolation?: { path: string; repo: string; cwd: string };
	/** The parent's team workspace, for a child whose cwd is an isolated worktree (a different git root). */
	workspace?: string;
	/** Its handoff folder: files it writes there are read by the parent on demand instead of riding in its report. */
	scratch?: string;
	/** The parent's Octocode session id: the backlog claims the child may update. */
	parentSession?: string;
	/** This run's id (`RunDetails.runId`): names the stop report the child or its parent saves for it (`parentGoneReportId`). */
	runId?: string;
	/** The backlog item the parent started the child for (`B12`): the only one it may update; its report is noted on it. */
	item?: string;
	parentTranscript?: string;
	/**
	 * The parent's permission mode now, and what its spawn ask granted. A spawn the user approved in `manual` or
	 * `workspace` also grants the profile's reach (`file.workspace`, `shell`) for the whole run, which is looser than the
	 * mode alone: the ask names that reach, so the approval is the consent. Destructive shell, outside changes and
	 * browser control never pass down this way.
	 */
	permission?: { mode: PermissionMode; grants: readonly ActionClass[] };
	/** The parent can ask a person: the child sends its approval dialogs to the parent (`OCTOCODE_PERMISSION_RELAY`) instead of denying them. */
	relay?: boolean;
	/** Paths the parent reserved for it (a task's `paths`), as given: its assignment names them, and a follow-up takes them again. */
	reservedPaths?: readonly string[];
	/** Running agents under the same coordinator when it started, one bounded line each (`siblings.ts`); absent when none. */
	siblings?: string;
	/** The identity text the parent appended to the child's latest task (`identityBlock`); the child re-reads it after a compaction (`identity-reminder.ts`). */
	assignment?: string;
}

/**
 * Child environment. `nonceFile` holds the child's own secret (`PERMISSION_NONCE_FILE_ENV`; the secret itself never goes in an environment). A browser profile with headless=false gets visible Chrome on the persistent profile. The user's
 * hooks stay off in a child unless its hook mode says otherwise (`identity.hooks`, else the profile's; `SUBAGENT_HOOKS_ENV`
 * carries `decisions` or `all`): a hook meant for the main session (a Stop hook that runs the tests, a notifier) would
 * otherwise fire once per subagent.
 */
export function subagentProcessEnv(
	profile: AgentProfile | undefined,
	base: NodeJS.ProcessEnv = process.env,
	identity?: Identity,
	nonceFile?: string,
	rolePromptFile?: string,
	skillSnapshotFile?: string,
	mcpServersFile?: string,
): NodeJS.ProcessEnv {
	const inherited = { ...base };
	const hooks = identity?.hooks ?? childHookMode(profile?.hooks);
	// User settings survive; run identity, permissions and browser mode belong to this child (trust comes from the shared trust store).
	for (const key of [...CHILD_OWNED_ENV, PERMISSION_ENV]) delete inherited[key];
	return {
		...inherited,
		...(identity?.promptCacheKey ? { [PROMPT_CACHE_KEY_ENV]: identity.promptCacheKey } : {}),
		...(identity?.cachePreferences?.cacheRetention
			? { [CACHE_RETENTION_ENV]: identity.cachePreferences.cacheRetention }
			: {}),
		...(identity?.cachePreferences?.instructionCacheRetention
			? { [INSTRUCTION_CACHE_RETENTION_ENV]: identity.cachePreferences.instructionCacheRetention }
			: {}),
		// Children ask the provider why a request missed the cache (Anthropic API only) so a cold start can be attributed; a user value wins.
		[CACHE_DIAGNOSTICS_ENV]: inherited[CACHE_DIAGNOSTICS_ENV] ?? "on",
		...(hooks === "off" ? {} : { [SUBAGENT_HOOKS_ENV]: hooks }),
		...(profile?.mcpDefer?.length ? { [MCP_DEFER_ROLES_ENV]: profile.mcpDefer.join(",") } : {}),
		...(identity?.mcpRecent ? { [MCP_RECENT_TOOLS_ENV]: JSON.stringify(identity.mcpRecent) } : {}),
		...(profile?.readOnly ? { [READ_ONLY_ENV]: "1" } : {}),
		// A lean child's prompt is its role and task only: no memory notes are injected either.
		...(profile?.lean ? { [LEAN_ENV]: "1", [MEMORY_AUTO_ENV]: "0" } : {}),
		...(identity?.skillsInTask ? { [SKILLS_IN_TASK_ENV]: "1" } : {}),
		[SUBAGENT_ENV]: "1",
		[NESTING_ENV]: String(nestingOf(base) + 1),
		...(rolePromptFile ? { [ROLE_PROMPT_FILE_ENV]: rolePromptFile } : {}),
		...(skillSnapshotFile ? { [SKILL_SNAPSHOT_FILE_ENV]: skillSnapshotFile } : {}),
		...(mcpServersFile ? { [MCP_SESSION_SERVERS_FILE_ENV]: mcpServersFile } : {}),
		...(identity ? { [AGENT_ID_ENV]: identity.id } : {}),
		...(identity?.runId ? { [AGENT_RUN_ID_ENV]: identity.runId } : {}),
		...(identity?.parentId ? { [PARENT_ID_ENV]: identity.parentId } : {}),
		...(identity?.parentWaits ? { [PARENT_WAITS_ENV]: "1" } : {}),
		...(identity?.reservedPaths?.length ? { [PARENT_HOLDS_LEASES_ENV]: "1" } : {}),
		...(identity?.role ? { [AGENT_ROLE_ENV]: identity.role } : {}),
		...(identity?.goal ? { [AGENT_GOAL_ENV]: identity.goal } : {}),
		...(identity?.isolation
			? { [WORKTREE_ROOT_ENV]: identity.isolation.path, [PROMPT_ROOT_ENV]: identity.isolation.repo }
			: {}),
		...(identity?.workspace ? { [TEAM_WORKSPACE_ENV]: identity.workspace } : {}),
		...(identity?.scratch ? { [AGENT_SCRATCH_ENV]: identity.scratch } : {}),
		...(identity?.parentTranscript ? { [PARENT_TRANSCRIPT_ENV]: identity.parentTranscript } : {}),
		...(identity?.parentSession ? { [PARENT_SESSION_ENV]: identity.parentSession } : {}),
		...(identity?.item ? { [BACKLOG_ITEM_ENV]: identity.item } : {}),
		...(identity?.assignment ? { [SUBAGENT_ASSIGNMENT_ENV]: identity.assignment } : {}),
		// The pid and its start time name this process, so a child never mistakes a later process with the pid for its parent.
		...(identity ? { [PARENT_PID_ENV]: [process.pid, processStartTime(process.pid)].filter(Boolean).join(" ") } : {}),
		...(nonceFile ? { [PERMISSION_NONCE_FILE_ENV]: nonceFile } : {}),
		...(identity?.relay ? { [PERMISSION_RELAY_ENV]: "1" } : {}),
		...(identity?.permission ? { [PERMISSION_ENV]: identity.permission.mode } : {}),
		...(identity?.permission?.grants.length ? { [PERMISSION_GRANTS_ENV]: identity.permission.grants.join(",") } : {}),
	};
}

/**
 * Writes `nonce` to a new owner-only file in this session's private folder and returns its path, or undefined when it
 * cannot be written (the child then runs without a secret: its headers and audit entries are not accepted, and it logs that).
 * The child reads the file once and unlinks it (`takeNonce`); `runSubagent` removes it at the end of the run otherwise.
 */
export function writeNonceFile(nonce: string, id: string): string | undefined {
	try {
		const file = path.join(
			outputDir("child-credentials"),
			`nonce-${id.replace(/[^\w.-]/g, "_")}-${randomBytes(8).toString("hex")}`,
		);
		fs.writeFileSync(file, nonce, { flag: "wx", mode: PRIVATE_FILE_MODE });
		return file;
	} catch {
		return undefined;
	}
}
