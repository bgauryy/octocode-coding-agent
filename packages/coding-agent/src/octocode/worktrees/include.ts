import { constants, copyFileSync, lstatSync, mkdirSync, realpathSync, readFileSync } from "node:fs";
import path from "node:path";
import { isWithin } from "../shared/home/repo.ts";
import { git } from "../shared/git.ts";

/** The optional file at a checkout's root that lists, in `.gitignore` syntax, untracked files a new worktree takes along. */
const WORKTREE_INCLUDE = ".worktreeinclude";

/** At most this many files are copied into one new worktree. */
export const INCLUDE_MAX_FILES = 2000;
/** At most this many bytes are copied into one new worktree. */
export const INCLUDE_MAX_BYTES = 100 * 1024 * 1024;
/**
 * Dependency and build folders, at any depth. A pattern like `.env` or `*.secret` also matches inside them, so their
 * files are left out unless a `.worktreeinclude` line names the folder (`node_modules/foo`).
 */
const HEAVY_FOLDERS: ReadonlySet<string> = new Set([
	"node_modules",
	"vendor",
	"dist",
	"build",
	"target",
	".next",
	".nuxt",
	".turbo",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	".gradle",
]);

export interface IncludeResult {
	/** Relative paths copied into the new worktree. */
	copied: string[];
	/** Paths not copied, with the reason: exists, symlink, outside the checkout, a skipped folder (`dir/`) or the copy limit. */
	skipped: Array<{ path: string; reason: string }>;
}

const files = (count: number): string => `${count} file${count === 1 ? "" : "s"}`;

/** The checkout's `.worktreeinclude` and its text when it is a regular file with content. */
function patterns(source: string): { file: string; text: string } | undefined {
	const file = path.join(source, WORKTREE_INCLUDE);
	try {
		if (!lstatSync(file).isFile()) return undefined;
		const text = readFileSync(file, "utf8");
		return text.trim() ? { file, text } : undefined;
	} catch {
		return undefined;
	}
}

/** The heavy folders a positive pattern names as a path component, such as `node_modules/foo` or `dist/`. */
function namedFolders(text: string): Set<string> {
	const named = new Set<string>();
	for (const line of text.split(/\r?\n/u)) {
		const pattern = line.trim();
		if (!pattern || pattern.startsWith("#") || pattern.startsWith("!")) continue;
		for (const part of pattern.split("/")) if (HEAVY_FOLDERS.has(part)) named.add(part);
	}
	return named;
}

/** The heavy folder (`packages/a/node_modules/`) holding `relative` that no pattern names, if any. */
function leftOutFolder(relative: string, named: ReadonlySet<string>): string | undefined {
	const parts = relative.split("/");
	const at = parts.slice(0, -1).findIndex((part) => HEAVY_FOLDERS.has(part) && !named.has(part));
	return at === -1 ? undefined : `${parts.slice(0, at + 1).join("/")}/`;
}

/** True when no component of `relative` under `root` is a symlink, so writing there cannot leave `root`. */
function plainPath(root: string, relative: string): boolean {
	let current = root;
	for (const part of relative.split("/")) {
		current = path.join(current, part);
		try {
			if (lstatSync(current).isSymbolicLink()) return false;
		} catch {
			return true; // the rest does not exist yet
		}
	}
	return true;
}

/**
 * Copies the untracked files of `source` that `.worktreeinclude` matches into the same relative paths under
 * `destination`. Existing files are never overwritten, symlinks are never copied or followed, and a path that would
 * leave either checkout is skipped. Files in dependency and build folders (`HEAVY_FOLDERS`) that no pattern names are
 * left out, and copying stops at `INCLUDE_MAX_FILES` files or `INCLUDE_MAX_BYTES` bytes; `skipped` says what was left out and
 * why. No file or no pattern: nothing happens.
 */
export async function copyIncluded(source: string, destination: string): Promise<IncludeResult> {
	const result: IncludeResult = { copied: [], skipped: [] };
	const include = patterns(source);
	if (!include) return result;
	const listing = await git(source, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${include.file}`], {
		raw: true,
	});
	const realSource = realpathSync.native(source);
	const realDestination = realpathSync.native(destination);
	const named = namedFolders(include.text);
	const leftOut = new Map<string, number>();
	let bytes = 0;
	let unreached = 0;
	for (const relative of listing.split("\0")) {
		if (!relative || relative.endsWith("/")) continue; // a nested repository is listed as `dir/`
		const folder = leftOutFolder(relative, named);
		if (folder) {
			leftOut.set(folder, (leftOut.get(folder) ?? 0) + 1);
			continue;
		}
		if (unreached > 0 || result.copied.length >= INCLUDE_MAX_FILES) {
			unreached++;
			continue;
		}
		const from = path.join(source, relative);
		const to = path.join(destination, relative);
		const skip = (reason: string) => result.skipped.push({ path: relative, reason });
		if (relative.split("/").includes("..") || path.isAbsolute(relative)) {
			skip("outside the checkout");
			continue;
		}
		try {
			const info = lstatSync(from);
			if (info.isSymbolicLink()) skip("symlink");
			else if (!info.isFile()) skip("not a regular file");
			else if (!plainPath(source, relative) || !isWithin(realpathSync.native(from), realSource))
				skip("outside the checkout");
			else if (!plainPath(destination, relative)) skip("outside the worktree");
			else if (bytes + info.size > INCLUDE_MAX_BYTES) unreached++;
			else {
				mkdirSync(path.dirname(to), { recursive: true });
				if (!isWithin(realpathSync.native(path.dirname(to)), realDestination)) skip("outside the worktree");
				else {
					copyFileSync(from, to, constants.COPYFILE_EXCL);
					result.copied.push(relative);
					bytes += info.size;
				}
			}
		} catch (error) {
			skip((error as NodeJS.ErrnoException).code === "EEXIST" ? "already exists" : "could not be read or written");
		}
	}
	for (const [folder, count] of leftOut)
		result.skipped.push({
			path: folder,
			reason: `${files(count)} in a dependency or build folder; a .worktreeinclude line naming the folder copies it`,
		});
	if (unreached > 0)
		result.skipped.push({
			path: `${unreached} more file${unreached === 1 ? "" : "s"}`,
			reason: `copy limit reached (${INCLUDE_MAX_FILES} files or ${INCLUDE_MAX_BYTES / (1024 * 1024)} MB)`,
		});
	return result;
}
