import fs from "node:fs";
import os from "node:os";
import { AGENT_DIR, AGENT_FOLDERS } from "../../storage/agent-layout.ts";
import path from "node:path";
import { OCTOCODE_DIR, resolveToolPath } from "../shared/home.ts";
import { ENV_AGENT_DIR, getAgentDir, getOctocodeHome, providerFallbackDirs } from "../../config.ts";
import { CONTEXT_FILE_CANDIDATES } from "../../core/discovery/sources.ts";
import { globalPaths } from "../../storage/state-paths.ts";
import { ownWorktreeRoot } from "../worktree-paths/own-worktree.ts";
import type { ActionClass } from "./mode.ts";
import type { BashFileTarget } from "./bash-types.ts";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { canonicalPaths } from "@octocodeai/octocode-common/canonical-path-set";
import { isWithin } from "@octocodeai/octocode-common/paths";
import { workspaceRoot } from "../../utils/git-repository.ts";
import { agentStateEntry, loadedByLaterSessions, loadedFromAgentDir } from "./later-session-loaded.ts";
import { memoryFileRefusal } from "./memory-files.ts";
import { foldName } from "./fold-name.ts";

/**
 * Repository folders that load code, hooks or agent instructions in later sessions (git config, Pi, Claude Code, Codex,
 * Cursor and Agents project config): a change there outlives the session, so it asks like an outside change.
 * `.octocode/` is not here as a whole: only its entries in `LOADED_BY_LATER_SESSIONS` and `.octocode/agent/`'s in
 * `loadedFromAgentDir` ask; scratch (`.octocode/agent/tmp/`) and report folders (`.octocode/agent/<topic>/`) run unasked.
 * Each list keeps the spelling its loader opens, which the sandbox's `protectedPaths` uses as is; `runsLater` compares
 * them folded (`foldName`).
 */
export const RUNS_LATER_AT_ROOT = [".git", ".pi", ".claude", ".codex", ".cursor", ".agents"];
/**
 * Paths that run or load code or instructions at any depth: a nested repository's hooks, a package's `.husky`, a
 * folder's `.envrc`, and the instruction files (`CONTEXT_FILE_CANDIDATES`) a session loads from the folder it starts in
 * and from each folder below it that it reads.
 */
export const RUNS_LATER_ANYWHERE = [
	".git/hooks",
	".git/config",
	".gitmodules",
	".npmrc",
	".mcp.json",
	".husky",
	".github/workflows",
	".vscode/tasks.json",
	".envrc",
	".pre-commit-config.yaml",
	"lefthook.yml",
	".lefthook.yml",
	"lefthook.yaml",
	...CONTEXT_FILE_CANDIDATES,
];
const AT_ROOT = RUNS_LATER_AT_ROOT.map((entry) => foldName(entry));
const ANYWHERE = [...new Set(RUNS_LATER_ANYWHERE.map((entry) => foldName(entry)))];
const OCTOCODE_FOLDER = foldName(OCTOCODE_DIR);
const AGENT_PREFIX = `${foldName(AGENT_DIR.split(path.sep).join("/"))}/`;

/** Whether `relative` (folded, `/`-separated) is the `OCTOCODE_DIR` folder itself or an entry of it that a later session loads. */
function loadedFromOctocodeDir(relative: string): boolean {
	if (relative === OCTOCODE_FOLDER) return true;
	if (relative.startsWith(AGENT_PREFIX))
		return loadedFromAgentDir(relative.slice(AGENT_PREFIX.length).split("/")[0] ?? "");
	if (!relative.startsWith(`${OCTOCODE_FOLDER}/`)) return false;
	return loadedByLaterSessions(relative.slice(OCTOCODE_FOLDER.length + 1).split("/")[0] ?? "");
}

/**
 * Whether a change to `file` (canonical, inside `root`) outlives the session. Compared folded (`foldName`): on macOS and
 * Windows `.CLAUDE/settings.json` and `.octocode/ſettings.json` are the files later sessions load, and on a
 * case-sensitive filesystem the extra match only asks.
 */
export function runsLater(file: string, root: string): boolean {
	const relative = foldName(path.relative(root, file).split(path.sep).join("/"));
	const rooted =
		loadedFromOctocodeDir(relative) || AT_ROOT.some((entry) => relative === entry || relative.startsWith(`${entry}/`));
	return (
		rooted || ANYWHERE.some((entry) => `/${relative}`.endsWith(`/${entry}`) || `/${relative}`.includes(`/${entry}/`))
	);
}

/**
 * Whether a change to `file` (canonical) stays inside the workspace `root`: it lies under `root` and is not an existing
 * file that other names share. A hard link (`ln ~/.zshrc z`) puts a file from anywhere at a workspace path, and a change
 * through that path changes the file everywhere it is linked.
 */
export function changesOnlyWorkspace(file: string, root: string): boolean {
	if (!isWithin(file, root)) return false;
	try {
		const stat = fs.statSync(file);
		return stat.isDirectory() || stat.nlink <= 1;
	} catch (error) {
		// Only a file that does not exist yet is new; one the check cannot read may be a link to anywhere.
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/** What Octocode reads from each fallback folder (the older Octocode folders' and Pi's): keys, OAuth tokens, models, settings. */
const FALLBACK_STORE_FILES = ["auth.json", "mcp-auth.json", "models.json", "settings.json"];

/** The global agent state folders (for this process's variables and for a session started without them), whose scratch folders are data. */
const agentStates = (none: NodeJS.ProcessEnv): string[] => [
	...new Set([globalPaths().agentState, globalPaths(none).agentState]),
];

/**
 * Where Octocode keeps its state or reads credentials outside a workspace, for a session started with this process's
 * variables and for one started without them (which reads the default places, so a file planted there reaches it): the
 * Octocode home and the agent directory (`OCTOCODE_CODING_AGENT_DIR`), apart from an isolated child's own worktree
 * (`homes`, listed first); the global agent state and the agents-communication database; and the credential, model and
 * settings files of the fallback folders (`providerFallbackDirs`: `~/.octocode`, `~/.octocode/agent`, Pi's).
 */
function spelledStores(): { paths: string[]; homes: number; always: number } {
	const none: NodeJS.ProcessEnv = {};
	const homes = [...new Set([getOctocodeHome(), getAgentDir(), getOctocodeHome(none)])];
	const always = [
		...[globalPaths(), globalPaths(none)].flatMap(({ agentState, peerCommunication }) => [
			agentState,
			peerCommunication,
		]),
		...providerFallbackDirs(getOctocodeHome(none), os.homedir(), none).flatMap((dir) =>
			FALLBACK_STORE_FILES.map((name) => path.join(dir, name)),
		),
	];
	const stores = [...new Set(always)];
	return { paths: [...homes, ...stores, ...agentStates(none)], homes: homes.length, always: stores.length };
}

/** The stores by the variables that place them; their folded canonical paths by the canonical list they come from. */
let spelled: { key: string; stores: ReturnType<typeof spelledStores> } | undefined;
let folded: { from: string[]; homes: string[]; always: string[]; scratch: string[] } | undefined;

/**
 * `spelledStores`, folded and canonical. A check runs on every file change and shell write target, so the list is
 * built once per set of variables, and canonicalized together and remembered while the folders it resolves through are
 * unchanged (`canonicalPaths`: one `stat` per folder).
 */
function stateStores(): { homes: string[]; always: string[]; scratch: string[] } {
	const key = [process.env.OCTOCODE_HOME, process.env[ENV_AGENT_DIR], os.homedir()].join("\0");
	if (spelled?.key !== key) spelled = { key, stores: spelledStores() };
	const canonical = canonicalPaths(spelled.stores.paths);
	if (folded?.from !== canonical) {
		const all = canonical.map((entry) => foldName(entry));
		const cut = spelled.stores.homes;
		const end = cut + spelled.stores.always;
		folded = { from: canonical, homes: all.slice(0, cut), always: all.slice(cut, end), scratch: all.slice(end) };
	}
	return folded;
}

const [AGENT_PARENT, AGENT_FOLDER] = foldName(AGENT_DIR).split(path.sep);
const TEMP_FOLDER = foldName(AGENT_FOLDERS.temp);

/** Whether `parts` (a folded canonical path, split) runs through a workspace's `.octocode/agent/` state, `temp/sessions/` included. */
function workspaceState(parts: string[]): boolean {
	return parts.some(
		(name, i) =>
			name === AGENT_PARENT &&
			parts[i + 1] === AGENT_FOLDER &&
			((parts[i + 2] !== undefined && agentStateEntry(parts[i + 2])) ||
				(parts[i + 2] === TEMP_FOLDER && parts[i + 3] === "sessions")),
	);
}

const SCRATCH_FOLDERS = new Set([AGENT_FOLDERS.tmp, AGENT_FOLDERS.temp].map((name) => foldName(name)));

/** Whether `folded` is in the `tmp/` or `temp/` (not `temp/sessions/`) scratch of a global agent state folder, as in a workspace. */
function globalScratch(folded: string, scratch: string[]): boolean {
	const store = scratch.find((root) => isWithin(folded, root));
	if (store === undefined) return false;
	const [folder, next] = folded.slice(store.length).split(path.sep).filter(Boolean);
	return folder !== undefined && SCRATCH_FOLDERS.has(folder) && !(folder === TEMP_FOLDER && next === "sessions");
}

/**
 * The refusal for a change to Octocode's state or a credential store it reads (`stateStores`; a workspace's
 * `.octocode/agent/` state), in every mode. Compared folded (`foldName`), so no spelling the file system folds onto one
 * of them escapes. An isolated subagent works in a worktree under the Octocode home, so the home part of the rule does
 * not apply to that one folder when the caller says where the process runs (`cwd`, `ownWorktreeRoot`): not to a
 * sibling's worktree, and not to a checkout's own `.octocode/agent` state inside it.
 */
export function stateFolderRefusal(
	file: string,
	shown: string,
	tool: string,
	cwd?: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const real = canonicalPath(file);
	const folded = foldName(real);
	const { homes, always, scratch } = stateStores();
	const parts = folded.split(path.sep);
	if (!workspaceState(parts) && globalScratch(folded, scratch)) return undefined;
	if (!workspaceState(parts) && !always.some((store) => isWithin(folded, store))) {
		if (!homes.some((home) => isWithin(folded, home))) return undefined;
		const own = cwd === undefined ? undefined : ownWorktreeRoot(cwd, env);
		if (own !== undefined && isWithin(real, own)) return undefined;
	}
	const resolved = real === shown ? "" : ` (${shown} → ${real})`;
	return `${shown} is in Octocode's state folder${resolved}; ${tool} does not change it. Ask the user to change it themselves.`;
}

/**
 * The path a shell command's operand names, for a containment check. The shell resolves `..` after following symlinks
 * (`link/../x` leaves the directory the link points into), so a path that spells `..` stays unnormalised for
 * `canonicalPath`; the file tools write the lexically resolved path and use `resolveToolPath`.
 */
export function shellPath(cwd: string, raw: string): string {
	if (!/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(raw) || raw.startsWith("~")) return resolveToolPath(cwd, raw);
	return path.isAbsolute(raw) ? raw : `${path.resolve(cwd)}${path.sep}${raw}`;
}

/** `BashFileTarget.uncertain` for a target spelled with an expansion (`> $FILE`, `~`). */
export const DYNAMIC_TARGET = "dynamic file target";

/**
 * A shell word spelled from the home directory (`~`, `~/x`, `$HOME/x`, `"${HOME}/x"`) as a `~` path, which
 * `resolveToolPath` expands from the same `HOME` the shell sees; undefined for any other spelling (`~user`, a quoted
 * `"~/x"`, other variables, globs).
 */
export function homeSpelling(raw: string): string | undefined {
	if (/^~(?:\/[^$`*?[\\"'{}]*)?$/.test(raw)) return raw;
	const match = /^\$(?:HOME|\{HOME\})(\/[^$`*?[\\'{}]*)?$/.exec(raw.replaceAll('"', ""));
	return match ? `~${match[1] ?? ""}` : undefined;
}

/** The path a shell target names, for a containment check: its literal path, or a home spelling; undefined when unresolved. */
export function shellTargetPath(target: BashFileTarget): string | undefined {
	if (target.kind === "write" && (!target.uncertain || target.uncertain === DYNAMIC_TARGET)) {
		const home = homeSpelling(target.raw);
		if (home !== undefined) return home;
	}
	return target.uncertain ? undefined : target.path;
}

/**
 * How a shell target is treated: for any resolvable write (checked first, in every mode) the refusal of a curated
 * MEMORY.md file (it belongs to the `memory` tool) and of the state folder, then
 * the class a write outside the workspace or to a run-later file needs, or `uncertain` when it names no known place.
 */
export function shellTargetAccess(
	target: BashFileTarget,
	cwd: string,
): {
	refusal?: string;
	action?: ActionClass;
	uncertain?: boolean;
	protected?: boolean;
} {
	const spelled = shellTargetPath(target);
	if (!spelled) return { uncertain: true };
	const file = canonicalPath(shellPath(cwd, spelled));
	if (target.kind === "write") {
		const refusal =
			memoryFileRefusal(file, target.raw, "Bash", cwd) ?? stateFolderRefusal(file, target.raw, "Bash", cwd);
		if (refusal) return { refusal };
	}
	const root = workspaceRoot(cwd);
	if (target.kind === "read")
		return { protected: false, action: root !== undefined && isWithin(file, root) ? undefined : "read.outside" };
	const inside = root !== undefined && changesOnlyWorkspace(file, root);
	return {
		protected: inside && runsLater(file, root),
		action: inside && !runsLater(file, root) ? undefined : "file.outside",
	};
}
