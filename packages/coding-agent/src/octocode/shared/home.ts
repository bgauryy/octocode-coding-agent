import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeConfigDir } from "../../utils/host-config.ts";
import { CONFIG_DIR_NAME, getAgentDir, getContextOptimizationDir, getOctocodeHome } from "../../config.ts";
import { projectMcpConfigPaths as projectMcpFiles } from "../../../../common/src/mcp-paths.ts";
import { expandPath, resolveReadPath, resolveToCwd } from "../../core/tools/path-utils.ts";
import { sha256 } from "../../../../common/src/atomic-file.ts";
import { dirsToRepoRoot, isWithin, repoKey, workspaceRoot } from "./home/repo.ts";

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

/**
 * Creates `dir` (and missing parents) owner-only (0700), and tightens an existing `dir` to 0700: runtime state is
 * not for other users on the machine. A folder this user does not own keeps its mode.
 */
export function privateDir(dir: string): string {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(dir, 0o700);
	} catch {
		// Not ours to change (a shared OCTOCODE_HOME); the files in it are still owner-only.
	}
	return dir;
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

/**
 * `<workspace>/.octocode/tmp/<name>`: where agents hand results to each other as files, so a long result is read on
 * demand instead of riding in a model's context. The `tmp` folder ignores itself (`.gitignore` of `*`), so nothing in
 * it is committed, in this repository or any other. Created on first use.
 */
export function workspaceScratchDir(workspace: string, name: string): string {
	const root = path.join(workspace, OCTOCODE_DIR, "tmp");
	const dir = path.join(root, name);
	fs.mkdirSync(dir, { recursive: true });
	const ignore = path.join(root, ".gitignore");
	if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
	return dir;
}

/**
 * Where Octocode keeps things. `.octocode` is the one place, at two levels:
 *   global     `OCTOCODE_HOME` or `~/.octocode/octocodecode`: user config and runtime state
 *              (trust decisions, team DB, logs, spilled output, checkpoints, worktrees)
 *   workspace  `<repo root>/.octocode`: project config (loads only when the project is trusted) and `tmp/` scratch
 * Workspace paths resolve from the repository root, so a session started in a subfolder reads the same files.
 * Other agents' files (`.claude/…`, `.codex/…`) are read too; their names live here as well so
 * the loaders and the trust fingerprint (src/shared/trust.ts) always agree on the list.
 */

/** Entry names under the Octocode home. On-disk names are kept stable: existing files must keep resolving. */
export const HOME_NAMES = {
	skills: "skills",
	agents: "agents",
	hooks: "hooks.json",
	/** Not `trust.json`: that is the core `/trust` store (`ProjectTrustStore`), which lives in the same folder by default. */
	trust: "pi-trust.json",
	team: "team",
	api: "api",
	worktrees: "worktrees",
	/** Durable agent state: `octocode.db` and `sessions/<id>/{output,bash,checkpoints}`. */
	agentState: "agent",
	/** The octocode-agents-communication package's folder: `communication.sqlite` holds its sessions, messages and path leases. */
	peerCommunication: "agents-communication",
} as const;

type GlobalPaths = { readonly [K in keyof typeof HOME_NAMES]: string } & { readonly home: string };

/** Native state paths; peer communication keeps the external package's shared root. Nothing is created. */
export function globalPaths(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): GlobalPaths {
	const base = octocodeHome(env, home);
	const entries = Object.entries(HOME_NAMES).map(([key, name]) => [key, path.join(base, name)]);
	return {
		home: base,
		...Object.fromEntries(entries),
		peerCommunication: path.join(
			env.OCTOCODE_HOME?.trim() ? base : path.join(home, OCTOCODE_DIR),
			HOME_NAMES.peerCommunication,
		),
	} as GlobalPaths;
}

/** The durable agent database: `OCTOCODE_AGENT_DB`, else `<agentState>/octocode.db`. Nothing is created. */
export function agentDbPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.OCTOCODE_AGENT_DB?.trim();
	return override ? path.resolve(override) : path.join(globalPaths(env).agentState, "octocode.db");
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

/**
 * A session id as a folder name. An empty id or one made only of dots (`.`, `..`) would name the sessions folder or
 * its parent, so it is refused; every other id keeps the name it always had, so no saved data is orphaned.
 */
export function sessionDirName(id: string): string {
	const name = id.replace(/[^\w.-]/g, "_");
	if (/^\.*$/.test(name)) throw new Error(`Invalid session id ${JSON.stringify(id)}: it cannot name a session folder.`);
	return name;
}

/** `<agentState>/sessions`: one folder per session. Nothing is created. */
export const sessionsRoot = (env: NodeJS.ProcessEnv = process.env): string =>
	path.join(globalPaths(env).agentState, "sessions");

/** `<agentState>/sessions/<sanitized id>`. Nothing is created. */
export const sessionDir = (id: string, env: NodeJS.ProcessEnv = process.env): string =>
	path.join(sessionsRoot(env), sessionDirName(id));

/**
 * The folder names under `sessionsRoot` (each a session's sanitized id): a subagent's session id is its name, so a new
 * subagent avoids these to never inherit another run's archive or output, from any repository.
 */
export function sessionFolderNames(env: NodeJS.ProcessEnv = process.env): string[] {
	try {
		return fs.readdirSync(sessionsRoot(env));
	} catch {
		return [];
	}
}

let currentSession: string | undefined;

/** Sets the process-wide current session (the first `session_start` handler does, before anything writes output). */
export function setCurrentSession(id: string | undefined): void {
	currentSession = id?.trim() || undefined;
}

/** The process-wide current session id, if one is set. */
export const currentSessionId = (): string | undefined => currentSession;

/** Folder name for a process with no session yet (unit tests, before `session_start`); swept once the process is gone. */
export const PID_SESSION_PREFIX = "_pid-";

/** Session folders already created and tightened by `sessionOutputDir`: later calls only check they still exist. */
const preparedOutputDirs = new Set<string>();

/** The folders a session keeps under its own: spilled output, bash logs, checkpoint blobs and the archive of compacted history. */
type SessionFolder = "output" | "bash" | "checkpoints" | "archive";

/**
 * A session's `output`, `bash`, `checkpoints` or `archive` folder (the current session's, without `id`), by path only:
 * nothing is created. With no session set it is `<agentState>/sessions/_pid-<pid>/<kind>`.
 */
export function sessionFolder(
	kind: SessionFolder,
	id: string | undefined = currentSession,
	env: NodeJS.ProcessEnv = process.env,
): string {
	return path.join(
		id ? sessionDir(id, env) : path.join(sessionsRoot(env), `${PID_SESSION_PREFIX}${process.pid}`),
		kind,
	);
}

/**
 * The current session's private `output`, `bash`, `checkpoints` or `archive` folder, created on use. The folder and its
 * parents are made private once; a folder removed since (a sweep, a test) is made again.
 */
export function sessionOutputDir(kind: SessionFolder, env: NodeJS.ProcessEnv = process.env): string {
	const folder = sessionFolder(kind, currentSession, env);
	const dir = path.dirname(folder);
	if (preparedOutputDirs.has(folder) && fs.existsSync(folder)) return folder;
	privateDir(path.dirname(dir));
	privateDir(dir);
	privateDir(folder);
	preparedOutputDirs.add(folder);
	return folder;
}

/** Octocode Code's configuration directory, optionally resolved for a supplied user home. */
export const nativeAgentDir = (home?: string): string =>
	home === undefined ? getAgentDir() : getOctocodeHome({}, home);

interface WorkspacePaths {
	/** The repository root every workspace path hangs from. */
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

/** `<repo root>/.octocode` paths for `cwd`. Nothing is created. */
export function workspacePaths(cwd: string): WorkspacePaths {
	const { root } = repoKey(cwd);
	const dir = path.join(root, OCTOCODE_DIR);
	return {
		root,
		dir,
		skills: path.join(dir, "skills"),
		agents: path.join(dir, "agents"),
		hooks: path.join(dir, "hooks.json"),
		tmp: path.join(dir, "tmp"),
	};
}

/** Trust-gated project hook files: Claude Code, Codex, then Octocode's. */
export function projectHookFiles(cwd: string): string[] {
	const { root, hooks } = workspacePaths(cwd);
	return [
		path.join(root, ".claude", "settings.json"),
		path.join(root, ".claude", "settings.local.json"),
		path.join(root, ".codex", "hooks.json"),
		path.join(root, ".codex", "config.toml"),
		hooks,
	];
}

/** Trust-gated project subagent profile directories, least specific first. */
export function projectAgentDirs(cwd: string): string[] {
	return [workspacePaths(cwd).agents];
}

/** Trust-gated project skill directories Octocode does not load itself: `.claude/skills` from `cwd` up to the root, then Octocode's. */
export function projectSkillDirs(cwd: string): string[] {
	return [...dirsToRepoRoot(cwd).map((dir) => path.join(dir, ".claude", "skills")), workspacePaths(cwd).skills];
}

/** `file` with the home directory shown as `~`. */
export function tildePath(file: string, home = os.homedir()): string {
	const relative = path.relative(home, file);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? `~${path.sep}${relative}` : file;
}

/**
 * One line per config file for a status report: `✓` when it exists, `·` when not; files missing from `userFiles` are
 * project files, which load only in a trusted project.
 */
export function configFileLines(files: string[], userFiles: string[], home = os.homedir()): string[] {
	const user = new Set(userFiles);
	return [...new Set(files)].map((file) => {
		const note = user.has(file) ? "" : " (project: loads only when trusted, /trust)";
		return `  ${fs.existsSync(file) ? "✓" : "·"} ${tildePath(file, home)}${note}`;
	});
}

/** Claude source settings share the hook compatibility discovery and project trust boundary. */
export function claudeSettingsSources(
	cwd: string,
	trusted: boolean,
	home = os.homedir(),
): { path: string; anchor: string }[] {
	const user = claudeConfigDir(home);
	return [
		{ path: path.join(user, "settings.json"), anchor: user },
		...(trusted
			? projectHookFiles(cwd)
					.filter((file) => path.basename(path.dirname(file)) === ".claude")
					.map((file) => ({ path: file, anchor: cwd }))
			: []),
	];
}

/** Project MCP files, lowest precedence first. All require project trust. */
export const projectMcpConfigPaths = (cwd: string): string[] => projectMcpFiles(cwd, CONFIG_DIR_NAME);
