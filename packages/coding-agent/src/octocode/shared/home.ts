import { globalPaths } from "../../config/state-paths.ts";
export { agentDbPath, globalPaths, HOME_NAMES } from "../../config/state-paths.ts";
export {
	currentSessionId,
	currentSessionWorkspace,
	PID_SESSION_PREFIX,
	sessionDir,
	sessionDirName,
	sessionFolder,
	sessionFolderNames,
	sessionOutputDir,
	sessionsRoot,
	sessionTempRoot,
	setCurrentSession,
} from "../../config/runtime-paths.ts";
import { privateDir } from "../../../../common/src/file-mode.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeConfigDir } from "../../utils/host-config.ts";
import { getAgentDir, getContextOptimizationDir, getOctocodeHome } from "../../config.ts";
import { expandPath, resolveReadPath, resolveToCwd } from "../../core/tools/path-utils.ts";
import { sha256 } from "../../../../common/src/atomic-file.ts";
import { isWithin, repoKey, workspaceRoot } from "./home/repo.ts";
import { ensureWorkspaceStateDir, workspaceStateDir } from "../../config/workspace.ts";

export { privateDir };

/** The folder name Octocode uses at both levels: `~/.octocode` (global) and `<repo root>/.octocode` (workspace). */
export const OCTOCODE_DIR = ".octocode";

/** `<root>/.octocode` for a repository root already resolved by the caller. Nothing is created. */
export const workspaceOctocodeDir = (root: string): string => path.join(root, OCTOCODE_DIR);

/**
 * Octocode Code's home: `OCTOCODE_HOME` when set, else `~/.octocode/octocodecode`.
 */
export function octocodeHome(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
	return getOctocodeHome(env, home);
}

/**
 * A folder under the Octocode home for files a tool writes at runtime (logs, spilled output, browser profiles), so
 * nothing the agent produces lands in the shared temp directory. Created on first use.
 */
export function outputDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
	return privateDir(path.join(octocodeHome(env), name));
}

/** Resolve tracked and reserved files with the same rules as the native file tools. */
export function resolveToolPath(cwd: string, raw: string): string {
	return resolveToCwd(raw, cwd);
}

/**
 * Like `resolveToolPath`, but a relative path is joined to `cwd` without collapsing its `..` segments, so a later
 * `canonicalPath` follows a symlink before the `..` that comes after it, as the shell does.
 */
export function reservationPath(cwd: string, raw: string): string {
	const expanded = expandPath(raw);
	return path.isAbsolute(expanded) ? expanded : `${cwd}${path.sep}${expanded}`;
}

/** Paths of a `read` tool call, from a transcript of another host or an SDK caller's own `read` tool; native MCP reads carry verified metadata from shared/local-reads. */
export function readPaths(toolName: string, input: Record<string, unknown>, cwd: string): string[] {
	return toolName === "read" && typeof input.path === "string" ? [resolveReadPath(input.path, cwd)] : [];
}

/** Private, Git-ignored scratch for artifacts handed between agents. */
export function workspaceScratchDir(workspace: string, name: string): string {
	return ensureWorkspaceStateDir(workspace, `temp${path.sep}${name}`);
}

/** The agents-communication package's database (its default; the package takes no environment override). Nothing is created. */
export function peerDbPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(globalPaths(env).peerCommunication, "communication.sqlite");
}

/**
 * Where the package lists the non-default databases its live processes use (`--database <file>`): one `<pid>.json` per
 * process, in the format `PeerRegistry` (`src/team/peer-registry.ts`) reads. Nothing is created.
 */
export function peerRegistryDir(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(globalPaths(env).peerCommunication, "active-databases");
}

interface WorkspacePaths {
	/** The project configuration root. Runtime paths follow the nearest workspace declaration. */
	root: string;
	dir: string;
	skills: string;
	agents: string;
	hooks: string;
	/** Scratch space for agent hand-offs (see `workspaceScratchDir`). */
	tmp: string;
}

export interface ContextOptimizationDirs {
	/** User-level skills and MCP servers, shared by every project. */
	user: string;
	/** Skills inside the repository of `cwd` and servers its `.octocode/mcp.json` defines; absent outside a repository. */
	project?: { dir: string; root: string };
}

/**
 * Where optimized skill descriptions and MCP files live, by the scope of what they describe. Both are in the agent
 * directory, never in the repository: a project's folder is `projects/<name>-<hash>`, keyed by `repoKey(cwd).key`, so
 * worktrees of one repository share it and two repositories with a same-named skill or server do not overwrite each
 * other. Nothing is created.
 */
export function contextOptimizationDirs(cwd: string | undefined, agentDir = getAgentDir()): ContextOptimizationDirs {
	const user = getContextOptimizationDir(agentDir);
	const root = cwd === undefined ? undefined : workspaceRoot(cwd);
	if (cwd === undefined || root === undefined) return { user };
	const { key, name } = repoKey(cwd);
	const slug = name.replace(/[^\w.-]/g, "_").slice(0, 40) || "project";
	return { user, project: { dir: path.join(user, "projects", `${slug}-${sha256(key).slice(0, 12)}`), root } };
}

/** Whether `file` (symlinks resolved) belongs to the project of `dirs`, so its optimized text is stored there. */
export function inContextProject(dirs: ContextOptimizationDirs, file: string): boolean {
	if (!dirs.project) return false;
	let real = file;
	try {
		real = fs.realpathSync(file);
	} catch {
		// A missing file keeps its own path.
	}
	return isWithin(real, dirs.project.root);
}

/** Project configuration paths and workspace runtime paths for `cwd`. Nothing is created. */
export function workspacePaths(cwd: string): WorkspacePaths {
	const { root } = repoKey(cwd);
	const dir = path.join(root, OCTOCODE_DIR);
	return {
		root,
		dir,
		skills: path.join(dir, "skills"),
		agents: path.join(dir, "agents"),
		hooks: path.join(dir, "hooks.json"),
		get tmp() {
			return workspaceStateDir(cwd, "temp");
		},
	};
}

/** `<workspace root>/.octocode/tmp`: agent scratch that retention expires. Other `.octocode/<topic>/` folders hold durable output. */
export function octocodeTmpDir(root: string): string {
	return path.join(root, OCTOCODE_DIR, "tmp");
}

/** Trust-gated project subagent profile directories, least specific first. */
export function projectAgentDirs(cwd: string): string[] {
	return [workspacePaths(cwd).agents];
}

/** `file` with the home directory shown as `~`. */
export function tildePath(file: string, home = os.homedir()): string {
	const relative = path.relative(home, file);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? `~${path.sep}${relative}` : file;
}

/**
 * One line per config file for a status report: `✓` when it exists, `·` when not; files missing from `userFiles` are
 * project files.
 */
export function configFileLines(files: string[], userFiles: string[], home = os.homedir()): string[] {
	const user = new Set(userFiles);
	return [...new Set(files)].map((file) => {
		const note = user.has(file) ? "" : " (project)";
		return `  ${fs.existsSync(file) ? "✓" : "·"} ${tildePath(file, home)}${note}`;
	});
}

/** Claude source settings share the hook compatibility discovery and the folder trust boundary. */
export function claudeSettingsSources(
	cwd: string,
	trusted: boolean,
	home = os.homedir(),
): { path: string; anchor: string }[] {
	const user = claudeConfigDir(home);
	return [
		{ path: path.join(user, "settings.json"), anchor: user },
		...(trusted
			? ["settings.json", "settings.local.json"].map((name) => ({
					path: path.join(repoKey(cwd).root, ".claude", name),
					anchor: cwd,
				}))
			: []),
	];
}
