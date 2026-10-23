import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
