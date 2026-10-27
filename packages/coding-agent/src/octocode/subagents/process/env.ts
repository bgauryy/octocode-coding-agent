import type { McpServerConfig } from "../../../../../mcp/src/servers.ts";
import type { SkillResourceSnapshot } from "../../../core/skill-resource-snapshot.ts";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type CachePreferences, INSTRUCTION_CACHE_RETENTION_ENV } from "@octocodeai/octocode-ai/utils/cache-policy";
import { ROLE_PROMPT_FILE_ENV } from "../../instructions/role.ts";
import type { ActionClass, PermissionMode } from "../../permission/mode.ts";
import {
	BROWSER_VISIBLE_ENV,
	CACHE_RETENTION_ENV,
	HOOKS_ENV,
	MCP_BROWSER_ENV,
	READ_ONLY_ENV,
	MCP_SESSION_SERVERS_FILE_ENV,
	PARENT_SESSION_ENV,
	PARENT_TRANSCRIPT_ENV,
	PERMISSION_ENV,
	PERMISSION_GRANTS_ENV,
	PERMISSION_NONCE_FILE_ENV,
	PERMISSION_RELAY_ENV,
	SUBAGENT_ENV,
	SKILL_SNAPSHOT_FILE_ENV,
	TRUST_ROOT_ENV,
	AGENT_SCRATCH_ENV,
	TEAM_WORKSPACE_ENV,
} from "../../shared/env.ts";
import { PRIVATE_FILE_MODE, sessionOutputDir } from "../../shared/home.ts";
import { PROMPT_ROOT_ENV, WORKTREE_ROOT_ENV } from "../../shared/prompt-root.ts";
import { processStartTime } from "../../shared/process.ts";
import {
	AGENT_COLLABORATE_ENV,
	AGENT_GOAL_ENV,
	AGENT_ID_ENV,
	AGENT_ROLE_ENV,
	PARENT_ID_ENV,
	PARENT_PID_ENV,
} from "../../team/store/env.ts";
import { type AgentProfile, profileSelectsBrowser } from "../profiles.ts";
import type { ResultContract } from "../result-schema.ts";

/** The child's place in the team: its name (id), its role (profile), its goal, and the agent that started it. */
export interface Identity {
	resultContract?: ResultContract;
	skillResources?: SkillResourceSnapshot;
	/** MCP servers the parent's `mcp` tool added this session (the user confirmed them): the child registers them, and nothing is written to `mcp.json`. */
	mcpServers?: Readonly<Record<string, McpServerConfig>>;
	cachePreferences?: CachePreferences;
	id: string;
	role?: string;
	parentId?: string;
	goal?: string;
	/** Works with its sibling subagents (messages them directly), not only for its parent. */
	collaborate?: boolean;
	/**
	 * Set for an isolated child. `path` is its worktree, `repo` the main checkout and `cwd` where it runs. Its system
	 * prompt names the main checkout, so every child of one profile shares the prompt; the task names the worktree.
	 */
	isolation?: { path: string; repo: string; cwd: string };
	/** The parent's team workspace, for a child whose cwd is an isolated worktree (a different git root). */
	workspace?: string;
	/** Set only when the parent's project config is trusted: the repository whose stored decision an isolated child follows. */
	trustRoot?: string;
	/** Its handoff folder: files it writes there are read by the parent on demand instead of riding in its report. */
	scratch?: string;
	/** The parent's Octocode session id: the backlog claims the child may update. */
	parentSession?: string;
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
	const hooks = base[HOOKS_ENV];
	const inherited = { ...base };
	// User settings survive; run identity, trust delegation, permissions and browser mode belong to this child.
	const owned = [
		ROLE_PROMPT_FILE_ENV,
		SKILL_SNAPSHOT_FILE_ENV,
		MCP_SESSION_SERVERS_FILE_ENV,
		HOOKS_ENV,
		READ_ONLY_ENV,
		TRUST_ROOT_ENV,
		BROWSER_VISIBLE_ENV,
		PERMISSION_ENV,
		PERMISSION_GRANTS_ENV,
		PERMISSION_NONCE_FILE_ENV,
		PERMISSION_RELAY_ENV,
		WORKTREE_ROOT_ENV,
		PROMPT_ROOT_ENV,
		AGENT_ID_ENV,
		AGENT_ROLE_ENV,
		PARENT_ID_ENV,
		AGENT_GOAL_ENV,
		AGENT_COLLABORATE_ENV,
		AGENT_SCRATCH_ENV,
		PARENT_SESSION_ENV,
		PARENT_TRANSCRIPT_ENV,
		PARENT_PID_ENV,
	];
	for (const key of owned) delete inherited[key];
	return {
		...inherited,
		...(identity?.cachePreferences?.cacheRetention
			? { [CACHE_RETENTION_ENV]: identity.cachePreferences.cacheRetention }
			: {}),
		...(identity?.cachePreferences?.instructionCacheRetention
			? { [INSTRUCTION_CACHE_RETENTION_ENV]: identity.cachePreferences.instructionCacheRetention }
			: {}),
		...(profile?.hooks && hooks !== undefined ? { [HOOKS_ENV]: hooks } : {}),
		...(profile?.readOnly ? { [READ_ONLY_ENV]: "1" } : {}),
		// A child that cannot use browser tools does not start the browser MCP server (an inherited `0` stays).
		...(profileSelectsBrowser(profile) ? {} : { [MCP_BROWSER_ENV]: "0" }),
		[SUBAGENT_ENV]: "1",
		...(rolePromptFile ? { [ROLE_PROMPT_FILE_ENV]: rolePromptFile } : {}),
		...(skillSnapshotFile ? { [SKILL_SNAPSHOT_FILE_ENV]: skillSnapshotFile } : {}),
		...(mcpServersFile ? { [MCP_SESSION_SERVERS_FILE_ENV]: mcpServersFile } : {}),
		...(profile?.headless === false ? { [BROWSER_VISIBLE_ENV]: "1" } : {}),
		...(identity ? { [AGENT_ID_ENV]: identity.id } : {}),
		...(identity?.parentId ? { [PARENT_ID_ENV]: identity.parentId } : {}),
		...(identity?.role ? { [AGENT_ROLE_ENV]: identity.role } : {}),
		...(identity?.goal ? { [AGENT_GOAL_ENV]: identity.goal } : {}),
		...(identity?.collaborate ? { [AGENT_COLLABORATE_ENV]: "1" } : {}),
		...(identity?.isolation
			? { [WORKTREE_ROOT_ENV]: identity.isolation.path, [PROMPT_ROOT_ENV]: identity.isolation.repo }
			: {}),
		...(identity?.workspace ? { [TEAM_WORKSPACE_ENV]: identity.workspace } : {}),
		...(identity?.trustRoot ? { [TRUST_ROOT_ENV]: identity.trustRoot } : {}),
		...(identity?.scratch ? { [AGENT_SCRATCH_ENV]: identity.scratch } : {}),
		...(identity?.parentTranscript ? { [PARENT_TRANSCRIPT_ENV]: identity.parentTranscript } : {}),
		...(identity?.parentSession ? { [PARENT_SESSION_ENV]: identity.parentSession } : {}),
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
			sessionOutputDir("output"),
			`nonce-${id.replace(/[^\w.-]/g, "_")}-${randomBytes(8).toString("hex")}`,
		);
		fs.writeFileSync(file, nonce, { flag: "wx", mode: PRIVATE_FILE_MODE });
		return file;
	} catch {
		return undefined;
	}
}
