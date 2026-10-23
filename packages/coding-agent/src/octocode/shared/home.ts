import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeConfigDir } from "../../utils/host-config.ts";
import { getAgentDir, getOctocodeHome } from "../../config.ts";
import { resolveReadPath, resolveToCwd } from "../../core/tools/path-utils.ts";

/** The folder name Octocode uses at both levels: `~/.octocode` (global) and `<repo root>/.octocode` (workspace). */
export const OCTOCODE_DIR = ".octocode";

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

/** Owner-only mode for runtime files (logs, spilled output, checkpoint blobs): they can hold source and secrets. */
export const PRIVATE_FILE_MODE = 0o600;

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

/** Legacy core read paths; native MCP reads carry verified metadata from shared/local-reads. */
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
	browser: "browser",
	browserProfile: "browser-profile",
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
	if (/^\.*$/.test(name))
		throw new Error(`Invalid session id ${JSON.stringify(id)}: it cannot name a session folder.`);
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

/** Which repository a directory belongs to; the one answer every feature (team, backlog, memory, sessions, workspace files) uses. */
interface RepoKey {
	/** realpath of the git common dir (worktrees share their main repo's key), else `root`. */
	key: string;
	/** realpath of the git toplevel; without git, of the nearest directory holding `.git`, else of cwd. */
	root: string;
	name: string;
}

const repoCache = new Map<string, RepoKey>();

/**
 * `file` with symlinks resolved, so one file reached through two paths has one name: the realpath of its deepest
 * existing ancestor joined with the rest (the file itself may not exist yet). A dangling symlink on the way is followed
 * to its target, so a write through it is placed where it would land; a symlink loop stops after 40 hops.
 */
export function canonicalPath(file: string, hops = 40): string {
	const absolute = path.resolve(file);
	const rest: string[] = [];
	for (let dir = absolute; ; dir = path.dirname(dir)) {
		try {
			return path.join(fs.realpathSync.native(dir), ...rest.reverse());
		} catch {
			const target = hops > 0 ? linkTarget(dir) : undefined;
			if (target !== undefined)
				return canonicalPath(path.join(path.resolve(path.dirname(dir), target), ...rest.reverse()), hops - 1);
			const parent = path.dirname(dir);
			if (parent === dir) return absolute;
			rest.push(path.basename(dir));
		}
	}
}

/** Where the symlink `file` points (as written in the link), or undefined when it is not a symlink. */
function linkTarget(file: string): string | undefined {
	try {
		return fs.lstatSync(file).isSymbolicLink() ? fs.readlinkSync(file) : undefined;
	} catch {
		return undefined;
	}
}

/** Whether `file` is `dir` or under it (both already resolved; no symlinks are followed here). */
export function isWithin(file: string, dir: string): boolean {
	const relative = path.relative(dir, file);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * `cwd` and its ancestors up to the repository root (the nearest directory holding `.git`), nearest first; just
 * `cwd` outside a repository.
 */
export function dirsToRepoRoot(cwd: string): string[] {
	const dirs: string[] = [];
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		dirs.push(dir);
		if (fs.existsSync(path.join(dir, ".git"))) return dirs;
		if (path.dirname(dir) === dir) return [path.resolve(cwd)];
	}
}

/**
 * Whether a repository rooted at `root` is no workspace: the home folder or a folder above it (a dotfiles repository
 * makes `~` the git top level), or `/`. Everything under such a root would count as inside the workspace.
 */
function spansHome(root: string): boolean {
	return path.parse(root).root === root || isWithin(canonicalPath(os.homedir()), root);
}

/**
 * Which repository `cwd` belongs to, symlinks resolved, so one checkout reached through two paths is one repository.
 * A root that is the home folder, above it or `/` counts as no repository: `cwd` itself is then the root, as with no
 * `.git` at all, so a write elsewhere under home (`~/.zshrc`, `~/.ssh`) is outside the workspace. Cached per cwd; never
 * throws.
 */
export function repoKey(cwd: string): RepoKey {
	const cached = repoCache.get(cwd);
	if (cached) return cached;
	let found: { key: string; root: string };
	try {
		const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		const [common, top] = out.split(/\r?\n/).map((line) => line.trim());
		if (!common || !top) throw new Error("not a work tree");
		found = { key: canonicalPath(common), root: canonicalPath(top) };
	} catch {
		// No git (or not a work tree git can read): the nearest `.git` marker still names the repository.
		const root = canonicalPath(dirsToRepoRoot(cwd).at(-1) ?? cwd);
		found = { key: root, root };
	}
	const { key, root } = spansHome(found.root) ? { key: canonicalPath(cwd), root: canonicalPath(cwd) } : found;
	const result: RepoKey = { key, root, name: path.basename(root) };
	repoCache.set(cwd, result);
	return result;
}

/**
 * The folder a permission mode treats as "the workspace" for `cwd`: its repository root, or none when that root is the
 * home folder, a folder above it or `/` (a session started in `~` has no workspace: everything under `~`, from
 * `~/.ssh` to `~/.zshrc`, is outside it). The one rule behind every workspace-scoped allow; `repoKey` still names the
 * folder for per-repository state (team, backlog, memory).
 */
export function workspaceRoot(cwd: string): string | undefined {
	const { root } = repoKey(cwd);
	return spansHome(root) ? undefined : root;
}

/** Claude source settings share the hook compatibility discovery and project trust boundary. */
export function claudeSettingsSources(cwd: string, trusted: boolean, home = os.homedir()): { path: string; anchor: string }[] {
 const user = claudeConfigDir(home);
 return [{ path: path.join(user, "settings.json"), anchor: user },
  ...(trusted ? projectHookFiles(cwd).filter(file => path.basename(path.dirname(file)) === ".claude").map(file => ({path:file,anchor:cwd})) : [])];
}
