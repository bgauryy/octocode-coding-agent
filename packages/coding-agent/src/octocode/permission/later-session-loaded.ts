/**
 * Entries directly under a workspace's `.octocode/` that a later session loads as code, configuration or instructions:
 * a file planted there would run or steer that session, so a change there outlives the one that made it. Every other
 * entry (`tmp/`, a topic's report folder) is data that nothing loads. Compared lower-cased, because the folder is read
 * case-insensitively on macOS and Windows. When unsure whether something loads, list it: an extra entry only asks.
 *
 * Loaders, by entry:
 * - `settings.json`: `core/settings-manager/storage.ts` (project settings, which also name plugins, hooks and packages);
 * - `mcp.json`: `packages/mcp/src/paths.ts` (project MCP servers, which start programs);
 * - `lsp-servers.json`: the language servers the research server starts in a trusted project
 *   (`packages/mcp/src/recommended/octocode.json`, `OCTOCODE_TRUST_PROJECT_LSP_CONFIG`);
 * - `hooks.json`: `core/discovery/vendors/octocode.ts` (hook commands), and `hooks/` for the scripts it points at;
 * - `skills`, `prompts`, `themes`: `core/discovery/vendors/octocode.ts`, `core/skills.ts`, `core/prompt-templates.ts`,
 *   `core/resource-loader/themes.ts`;
 * - `agents`: subagent profiles, `octocode/shared/home.ts` (`projectAgentDirs`) and `octocode/discovery/agents.ts`;
 * - `system.md`, `append_system.md`: the system prompt, `core/discovery/vendors/octocode.ts`;
 * - `agents.md`, `agents.override.md`, `claude.md`: instruction files a session loads from the folder it starts in
 *   (`core/discovery/sources.ts`, `CONTEXT_FILE_CANDIDATES`; `CLAUDE.md` where the folder has no AGENTS file), which
 *   can be here;
 * - `plugins`: not discovered by folder; a plugin that `settings.json` names loads from any path (`core/plugin-resources.ts`),
 *   and this is the conventional place for it;
 * - `npm`, `git`: project-installed packages, `core/package-manager/npm.ts` and `git.ts` (code that loads as resources);
 * - `worktrees`: checkouts (`octocode/worktrees/repo.ts`) that a session can start in and load all of the above from;
 * - `code`: the workspace state folder (transcripts, workspace id, database), `config/workspace.ts`; only its
 *   `temp/` scratch is data (`file-access.ts`, `read-only-role.ts`);
 * - `octocodecode`: the repository's curated `MEMORY.md`, which every session loads into its prompt
 *   (`permission/memory-files.ts`, `memory/file/section.ts`).
 */
export const LOADED_BY_LATER_SESSIONS: ReadonlySet<string> = new Set(
	[
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
		"lsp-servers.json",
		"system.md",
		"append_system.md",
		"agents.md",
		"agents.override.md",
		"claude.md",
		"worktrees",
		"code",
		"octocodecode",
	].map((name) => name.toLowerCase()),
);
