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
	CACHE_RETENTION_ENV,
	SUBAGENT_HOOKS_ENV,
	READ_ONLY_ENV,
	LEAN_ENV,
	MEMORY_AUTO_ENV,
	SKILLS_IN_TASK_ENV,
	MCP_SESSION_SERVERS_FILE_ENV,
	PARENT_SESSION_ENV,
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
import { PROMPT_ROOT_ENV, WORKTREE_ROOT_ENV } from "../../worktree-paths/prompt-root.ts";
import { processStartTime } from "../../shared/process.ts";
import {
	AGENT_GOAL_ENV,
	AGENT_ID_ENV,
	AGENT_ROLE_ENV,
	PARENT_ID_ENV,
	PARENT_PID_ENV,
	PARENT_WAITS_ENV,
} from "../../team/store/env.ts";
import type { AgentProfile } from "../profiles.ts";
import type { ResultContract } from "../result-schema.ts";
import { CHILD_OWNED_ENV, NESTING_ENV, nestingOf } from "./child-env.ts";
import { SUBAGENT_ASSIGNMENT_ENV } from "../identity-reminder.ts";
import { PRIVATE_FILE_MODE } from "../../../../../common/src/file-mode.ts";

/** Asks the Anthropic API for its cache-miss reason (`ai/src/api/anthropic-messages/cache-diagnostics.ts`). */
const CACHE_DIAGNOSTICS_ENV = "OCTOCODE_CACHE_DIAGNOSTICS";

/**
 * The retention a child starts with. A child's median gap between requests is seconds, so the 5-minute history entry
 * outlives it and the 1-hour write premium buys nothing; its instructions stay long because siblings of a role share
 * them for longer. Only the shipped default changes: a user's setting (file, provider, model, environment) wins as
 * configured, and a child that lingers or resumes keeps the long history because its next request may follow a pause.
 */
export function childCachePreferences(
	policy: { options: CachePreferences; sources: Partial<Record<keyof CachePreferences, string>> },
	lingers: boolean,
): CachePreferences {
	if (lingers || policy.sources.cacheRetention !== "defaults") return policy.options;
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
	/** The configured servers the task gave the child (`mcp` on the task, plus those its tools name): any other stays out. */
	mcpOnly?: readonly string[];
	/** The servers the task named: their tools are added to the child's selection, so a server that is not active by default still starts. */
	mcpNamed?: readonly string[];
	cachePreferences?: CachePreferences;
	/** Lifetime of the history entry the child's requests write, when known (`cache-warmer/economics`). */
	cacheTtlMs?: number;
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
	/** The identity text the parent appended to the child's latest task (`identityBlock`); the child re-reads it after a compaction (`identity-reminder.ts`). */
	assignment?: string;
}

/**
 * Child environment. `nonceFile` holds the child's own secret (`PERMISSION_NONCE_FILE_ENV`; the secret itself never goes in an environment). A browser profile with headless=false gets visible Chrome on the persistent profile. The user's
 * command hooks stay off in children unless the profile sets `hooks: true`: a hook meant for the main session (a
 * Stop hook that runs the tests, a notifier) would otherwise fire once per subagent.
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
		...(profile?.hooks ? { [SUBAGENT_HOOKS_ENV]: "1" } : {}),
		...(profile?.mcpDefer?.length ? { [MCP_DEFER_ROLES_ENV]: profile.mcpDefer.join(",") } : {}),
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
		...(identity?.parentId ? { [PARENT_ID_ENV]: identity.parentId } : {}),
		...(identity?.parentWaits ? { [PARENT_WAITS_ENV]: "1" } : {}),
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
