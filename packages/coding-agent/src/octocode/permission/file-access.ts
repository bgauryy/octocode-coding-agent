import fs from "node:fs";
import { WORKSPACE_STATE } from "../../config/workspace.ts";
import path from "node:path";
import { OCTOCODE_DIR, octocodeHome, resolveToolPath } from "../shared/home.ts";
import { ownWorktreeRoot } from "../shared/own-worktree.ts";
import type { ActionClass } from "./mode.ts";
import type { BashFileTarget } from "./bash-types.ts";
import { canonicalPath, isWithin, workspaceRoot } from "../shared/home/repo.ts";

/**
 * Repository paths that load code, hooks or agent instructions in later sessions (git config, Octocode, Claude Code, Codex
 * and Octocode project config, skills): a change there outlives the session, so it asks like an outside change.
 */
const RUNS_LATER_AT_ROOT = [
	".git",
	".pi",
	".claude",
	".codex",
	".agents",
	OCTOCODE_DIR, // also holds the workspace state folder (`WORKSPACE_STATE`)
].map((entry) => entry.toLowerCase());
/** Octocode's scratch folder: nothing loads it, so a change there does not outlive the session (nested hooks still count). */
const SCRATCH_AT_ROOT = `${WORKSPACE_STATE.split(path.sep).join("/")}/temp`;
/** Paths that run or load code at any depth (a nested repository's hooks, a package's `.husky`, a folder's `.envrc`). */
const RUNS_LATER_ANYWHERE = [
	".git/hooks",
	".git/config",
	".gitmodules",
	".npmrc",
	".mcp.json",
	".husky",
	".github/workflows",
	".vscode/tasks.json",
	".envrc",
];

/**
 * Whether a change to `file` (canonical, inside `root`) outlives the session. Compared lower-cased: on macOS and Windows
 * `.CLAUDE/settings.json` is the folder Claude Code loads, and on a case-sensitive filesystem the extra match only asks.
 */
export function runsLater(file: string, root: string): boolean {
	const relative = path.relative(root, file).split(path.sep).join("/").toLowerCase();
	const scratch = relative === SCRATCH_AT_ROOT || relative.startsWith(`${SCRATCH_AT_ROOT}/`);
	const rooted = !scratch && RUNS_LATER_AT_ROOT.some((entry) => relative === entry || relative.startsWith(`${entry}/`));
	return (
		rooted ||
		RUNS_LATER_ANYWHERE.some((entry) => `/${relative}`.endsWith(`/${entry}`) || `/${relative}`.includes(`/${entry}/`))
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
	} catch {
		return true;
	}
}

/**
 * The refusal for a change inside Octocode's state folder (its trust store, agent database, config), in every mode. An
 * isolated subagent works in a worktree under the Octocode home, so the home part of the rule does not apply to that
 * one folder when the caller says where the process runs (`cwd`, `ownWorktreeRoot`): not to a sibling's worktree, and
 * not to a checkout's own `.octocode/code` inside it.
 */
export function stateFolderRefusal(
	file: string,
	shown: string,
	tool: string,
	cwd?: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const real = canonicalPath(file);
	const parts = real.toLowerCase().split(path.sep);
	const [parent, folder] = WORKSPACE_STATE.split(path.sep);
	const state = parts.some(
		(name, i) => name === parent && parts[i + 1] === folder && (parts[i + 2] !== "temp" || parts[i + 3] === "sessions"),
	);
	if (!state) {
		if (!isWithin(real, canonicalPath(octocodeHome()))) return undefined;
		const own = cwd === undefined ? undefined : ownWorktreeRoot(cwd, env);
		if (own !== undefined && isWithin(real, own)) return undefined;
	}
	return `${shown} is in Octocode's state folder; ${tool} does not change it. Ask the user to change it themselves.`;
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
 * How a shell target is treated: the state-folder refusal for any resolvable write (checked first, in every mode), then
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
		const refusal = stateFolderRefusal(file, target.raw, "Bash", cwd);
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
