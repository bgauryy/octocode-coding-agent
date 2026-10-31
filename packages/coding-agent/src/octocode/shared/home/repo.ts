import { gitMarkerDir } from "../../../utils/git-marker.ts";
import { gitSync } from "../git.ts";
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

/**
 * A repository answer with what it was computed from: the nearest `.git` marker above the folder and the home folder.
 * Both are cheap to read again, so the entry stays valid until one changes (`git init`, a nested repository, a deleted
 * checkout, another home), with no git process per call.
 */
interface CachedRepo {
	result: RepoKey;
	marker: string | undefined;
	home: string;
}

const repoCache = new Map<string, CachedRepo>();

/**
 * `file` with symlinks resolved, so one file reached through two paths has one name: the realpath of its deepest
 * existing ancestor joined with the rest (the file itself may not exist yet). A dangling symlink on the way is followed
 * to its target, so a write through it is placed where it would land; a symlink loop stops after 40 hops. A `..` is
 * applied after the link before it is followed, as the kernel does (`link/../x` is beside the link's target, not
 * beside the link), never collapsed lexically first.
 */
export function canonicalPath(file: string, hops = 40): string {
	const absolute = PARENT_SEGMENT.test(file) ? withParents(file, hops) : path.resolve(file);
	const rest: string[] = [];
	for (let dir = absolute; ; dir = path.dirname(dir)) {
		try {
			return path.join(fs.realpathSync.native(dir), ...rest.reverse());
		} catch {
			const target = hops > 0 ? linkTarget(dir) : undefined;
			if (target !== undefined)
				return canonicalPath(
					[path.isAbsolute(target) ? target : `${path.dirname(dir)}${path.sep}${target}`, ...rest.reverse()].join(
						path.sep,
					),
					hops - 1,
				);
			const parent = path.dirname(dir);
			if (parent === dir) return absolute;
			rest.push(path.basename(dir));
		}
	}
}

const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/** `file` made absolute and free of `.`/`..`, walking from the root so each `..` follows the symlinks before it. */
function withParents(file: string, hops: number): string {
	const absolute = path.isAbsolute(file) ? file : `${process.cwd()}${path.sep}${file}`;
	const { root } = path.parse(absolute);
	const segments = absolute.slice(root.length).split(path.sep === "\\" ? /[\\/]+/ : /\/+/);
	let current = root;
	for (const [index, segment] of segments.entries()) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			current = path.dirname(current);
			continue;
		}
		const next = path.join(current, segment);
		const target = hops > 0 ? linkTarget(next) : undefined;
		if (target === undefined) {
			current = next;
			continue;
		}
		const rest = segments.slice(index + 1);
		return withParents(
			[path.isAbsolute(target) ? target : `${current}${path.sep}${target}`, ...rest].join(path.sep),
			hops - 1,
		);
	}
	return current;
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
	const root = gitMarkerDir(cwd);
	if (root === undefined) return [path.resolve(cwd)];
	const dirs: string[] = [];
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		dirs.push(dir);
		if (dir === root) return dirs;
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
 * `.git` at all, so a write elsewhere under home (`~/.zshrc`, `~/.ssh`) is outside the workspace. Cached per cwd while
 * its nearest `.git` marker and the home folder stay as they were, so a later `git init` or a removed checkout is seen;
 * never throws.
 */
export function repoKey(cwd: string): RepoKey {
	const marker = gitMarkerDir(cwd);
	const home = os.homedir();
	const cached = repoCache.get(cwd);
	if (cached && cached.marker === marker && cached.home === home) return cached.result;
	let found: { key: string; root: string };
	try {
		const out = gitSync(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], {
			timeoutMs: 2000,
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
	repoCache.set(cwd, { result, marker, home });
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
