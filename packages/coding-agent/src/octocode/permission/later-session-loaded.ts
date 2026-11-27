import { CONTEXT_FILE_CANDIDATES } from "../../core/discovery/sources.ts";
import { AGENT_FOLDERS, MEMORY_FILE } from "../../storage/agent-layout.ts";
import { foldName } from "./fold-name.ts";

/**
 * Entries directly under a workspace's `.octocode/` that a later session loads as code, configuration or instructions:
 * a file planted there would run or steer that session, so a change there outlives the one that made it. Every other
 * entry (`tmp/`, a topic's report folder) is data that nothing loads. Each entry is spelled as its loader opens it, which
 * the sandbox protects as is (a case-sensitive Linux file system loads only that spelling); the file gate compares
 * folded (`loadedByLaterSessions`), as macOS and Windows open the folder. When unsure whether something loads, list it:
 * an extra entry only asks.
 *
 * Loaders, by entry:
 * - `settings.json`: `core/settings-manager/storage.ts` (project settings, which also name plugins, hooks and packages);
 * - `mcp.json`: `packages/mcp/src/paths.ts` (project MCP servers, which start programs);
 * - `lsp-servers.json`: the language servers the research server starts in a trusted project
 *   (`octocode` in `packages/mcp/src/default_mcp_config.json`, `OCTOCODE_TRUST_PROJECT_LSP_CONFIG`);
 * - `hooks.json`: `core/discovery/vendors/octocode.ts` (hook commands), and `hooks/` for the scripts it points at;
 * - `skills`, `prompts`, `themes`: `core/discovery/vendors/octocode.ts`, `core/skills.ts`, `core/prompt-templates.ts`,
 *   `core/resource-loader/themes.ts`;
 * - `agents`: subagent profiles, `octocode/shared/home.ts` (`projectAgentDirs`) and `octocode/discovery/agents.ts`;
 * - `models.json`: project providers, loaded in a trusted folder (`core/model-config/project.ts`); a key there can be a
 *   `!command` a later session runs;
 * - `SYSTEM.md`, `APPEND_SYSTEM.md`: the system prompt, `core/discovery/vendors/octocode.ts`;
 * - `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`: instruction files a session loads from the folder it starts in
 *   (`core/discovery/sources.ts`, `CONTEXT_FILE_CANDIDATES`; `CLAUDE.md` where the folder has no AGENTS file), which
 *   can be here;
 * - `plugins`: not discovered by folder; a plugin that `settings.json` names loads from any path (`core/plugin-resources.ts`),
 *   and this is the conventional place for it;
 * - `npm`, `git`: project-installed packages, `core/package-manager/npm.ts` and `git.ts` (code that loads as resources);
 * - `agent`: Octocode's own folder, split by `loadedFromAgentDir`; its other entries (`tmp/`,
 *   `temp/` scratch, a topic's report folder) are data.
 */
export const LOADED_BY_LATER_SESSIONS: readonly string[] = [
	"skills",
	"agents",
	"prompts",
	"themes",
	"plugins",
	"npm",
	"git",
	"hooks",
	"hooks.json",
	"settings.json",
	"mcp.json",
	"models.json",
	"lsp-servers.json",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
	...CONTEXT_FILE_CANDIDATES,
];
const LOADED_FOLDED: ReadonlySet<string> = new Set(LOADED_BY_LATER_SESSIONS.map((name) => foldName(name)));

/** Whether `entry`, directly under a workspace's `.octocode/`, is one a later session loads, however it is spelled. */
export const loadedByLaterSessions = (entry: string): boolean => LOADED_FOLDED.has(foldName(entry));

/** Octocode's private state directly under `.octocode/agent/`, folded: workspace id, transcripts, session data, the event view and backlog exports. */
const AGENT_STATE_ENTRIES: ReadonlySet<string> = new Set(
	[
		AGENT_FOLDERS.marker,
		AGENT_FOLDERS.sessions,
		AGENT_FOLDERS.sessionData,
		"agents.txt",
		"backlog.md",
		"backlog.html",
	].map((name) => foldName(name)),
);
const EVENT_VIEW = foldName("agents.txt");
const NOT_DATA = new Set([AGENT_FOLDERS.worktrees, MEMORY_FILE].map((name) => foldName(name)));

/** Whether `entry`, directly under `.octocode/agent/`, is Octocode's private state (the event view's lock and temporary files count), however it is spelled. */
export const agentStateEntry = (entry: string): boolean => {
	const name = foldName(entry);
	return AGENT_STATE_ENTRIES.has(name) || name.startsWith(EVENT_VIEW);
};

/**
 * Whether `entry`, directly under `.octocode/agent/`, is not data: Octocode's state, the checkouts under `worktrees/` that a
 * session can start in and load everything above from, or the curated `MEMORY.md` every session loads into its prompt
 * (`permission/memory-files.ts`). Only `temp/` (outside `temp/sessions/`), `tmp/` and topic folders are data.
 */
export const loadedFromAgentDir = (entry: string): boolean => agentStateEntry(entry) || NOT_DATA.has(foldName(entry));
