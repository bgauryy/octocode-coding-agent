import { copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { isWithin } from "@octocodeai/octocode-common/paths";
import { EXCLUDE_WORKSPACE_STATE, git, gitQuiet } from "../../utils/git-run.ts";

/** The installed-dependency folder a new worktree takes from its source checkout, at any depth, when Git ignores it there. */
const DEPENDENCY_FOLDER = "node_modules";

/**
 * Folders inside a dependency folder that are mirrored entry by entry instead of linked whole: a package scope (`@scope`,
 * which holds workspace links), the `.bin` launchers and pnpm's `.pnpm` store.
 */
const mirrored = (name: string): boolean => name.startsWith("@") || name === ".bin" || name === ".pnpm";

interface DependencyLinks {
	/** Dependency folders made in the worktree, relative to its root. */
	folders: string[];
	/** Paths not linked, with the reason. */
	skipped: Array<{ path: string; reason: string }>;
}

interface Link {
	from: string;
	to: string;
}

const present = (file: string): boolean => lstatSync(file, { throwIfNoEntry: false }) !== undefined;

/** Links `target` at `at`; a directory link is a junction on Windows, which needs no privilege there. */
const link = (target: string, at: string): void =>
	symlinkSync(target, at, statSync(target, { throwIfNoEntry: false })?.isDirectory() ? "junction" : "file");

/**
 * Makes `to` a real folder holding one link per entry of `from`. A plain package links to the source; a symlink is
 * queued in `links`, to be recreated once every plain entry exists. A dot file is package-manager state
 * (`.yarn-state.yml`, `.modules.yaml`, which `yarn run` reads) and is copied; another dot folder is a tool cache
 * (`.vite`, `.cache`) and left out. So an install or a cache in the worktree writes its own copy, never the source's.
 */
function mirror(from: string, to: string, links: Link[]): void {
	mkdirSync(to);
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		const source = path.join(from, entry.name);
		const target = path.join(to, entry.name);
		if (entry.isSymbolicLink()) links.push({ from: source, to: target });
		else if (entry.isDirectory() && mirrored(entry.name)) mirror(source, target, links);
		else if (!entry.name.startsWith(".")) link(source, target);
		else if (entry.isFile()) copyFileSync(source, target);
	}
}

/**
 * Where the source symlink `from` points from the worktree, judged by its real target (so a chain of links resolves in
 * any order): a target inside the source checkout (a workspace package, a pnpm store entry, a launcher's package) moves
 * to the same place in the worktree, so the child imports its own edits; undefined when the worktree lacks it or the
 * link dangles. A target outside the checkout is kept.
 */
function worktreeTarget(from: string, realSource: string, destination: string): string | undefined {
	let target: string;
	try {
		target = realpathSync.native(from);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!isWithin(target, realSource)) return target;
	const own = path.join(destination, path.relative(realSource, target));
	return statSync(own, { throwIfNoEntry: false }) ? own : undefined;
}

/** The `node_modules` folders Git ignores in `source`, relative to it; an ignored parent folder hides those under it. */
async function ignoredDependencyFolders(source: string): Promise<string[]> {
	const listing = await git(
		source,
		["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--", EXCLUDE_WORKSPACE_STATE],
		{ raw: true },
	);
	return listing
		.split("\0")
		.filter((entry) => entry.endsWith("/"))
		.map((entry) => entry.slice(0, -1))
		.filter((entry) => path.posix.basename(entry) === DEPENDENCY_FOLDER && !entry.split("/").includes(".."));
}

/**
 * Gives the new worktree `destination` the installed dependencies of the checkout `source` without an install. Each
 * `node_modules` folder Git ignores in `source` becomes a real folder at the same path in `destination`, holding one link
 * per package (`mirror`), with workspace links pointing into the worktree (`worktreeTarget`). The folder is real, not a
 * link, so a `node_modules/` ignore pattern (trailing slash) still ignores it and a cache written there stays in the
 * worktree; writes through a package link reach the source, where an isolated child's guard and sandbox refuse them.
 * Never overwrites: an existing path, a folder the worktree lacks or one it does not ignore is skipped with a reason.
 */
export async function linkDependencies(source: string, destination: string): Promise<DependencyLinks> {
	const result: DependencyLinks = { folders: [], skipped: [] };
	const folders = await ignoredDependencyFolders(source);
	if (folders.length === 0) return result;
	const realSource = realpathSync.native(source);
	const realDestination = realpathSync.native(destination);
	const links: Link[] = [];
	const made: string[] = [];
	for (const folder of folders) {
		const to = path.join(destination, folder);
		const parent = path.dirname(to);
		if (!statSync(parent, { throwIfNoEntry: false })?.isDirectory())
			result.skipped.push({ path: folder, reason: "its parent folder is not in the worktree" });
		else if (!isWithin(realpathSync.native(parent), realDestination))
			result.skipped.push({ path: folder, reason: "outside the worktree" });
		else if (present(to)) result.skipped.push({ path: folder, reason: "already exists" });
		else {
			mirror(path.join(source, folder), to, links);
			made.push(folder);
		}
	}
	const missing: string[] = [];
	for (const { from, to } of links) {
		const target = worktreeTarget(from, realSource, destination);
		if (target === undefined) missing.push(path.relative(destination, to));
		else link(target, to);
	}
	if (missing.length > 0)
		result.skipped.push({
			path: `${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` and ${missing.length - 3} more` : ""}`,
			reason: `${missing.length === 1 ? "a link whose target" : "links whose targets"} the worktree lacks, such as a workspace's unbuilt output`,
		});
	if (made.length === 0) return result;
	// The worktree's own ignore rules decide: finishing commits every untracked path they do not ignore. A path Git
	// quotes in its output does not match, so its folder is removed: the safe side.
	const listed = await gitQuiet(destination, ["check-ignore", "--", ...made]);
	const ignored = new Set(listed?.split("\n"));
	for (const folder of made) {
		if (ignored.has(folder)) result.folders.push(folder);
		else {
			rmSync(path.join(destination, folder), { recursive: true, force: true });
			result.skipped.push({
				path: folder,
				reason: "not ignored by Git in the worktree, so the result would commit it",
			});
		}
	}
	return result;
}
