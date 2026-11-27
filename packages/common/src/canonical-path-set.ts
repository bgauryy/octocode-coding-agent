import fs from "node:fs";
import path from "node:path";
import { canonicalPath } from "./canonical-path.ts";

/**
 * `canonicalPath` of a fixed list of absolute paths, remembered until the file system could answer differently. Each
 * path's answer depends only on the entries of the directories its resolution looks names up in (every directory from
 * the root to the deepest existing ancestor, and those a symlink on the way leads through); adding, removing, renaming
 * or retargeting an entry changes that directory's modification time. So a remembered list is reused while every such
 * directory keeps its device, inode, modification and change times, one `stat` each instead of a `realpath` and an
 * `lstat` walk per path. A path whose resolution cannot be traced (a symlink loop, a relative path) is never
 * remembered: the list is then canonicalized on every call, as before.
 */
export function canonicalPaths(files: readonly string[]): string[] {
	const id = files.join("\0");
	const known = remembered.get(id);
	if (known && stampOf(known.dirs) === known.stamp) return known.values;
	// Stamped before the paths are read: a change while they are read makes the next call read them again. A change
	// that moves the walk itself (traced again after) is not remembered at all.
	const dirs = tracedDirs(files);
	const stamp = dirs && stampOf(dirs);
	const values = files.map((file) => canonicalPath(file));
	remembered.delete(id);
	if (dirs && stamp !== undefined && tracedDirs(files)?.join("\0") === dirs.join("\0")) {
		remembered.set(id, { values, dirs, stamp });
		if (remembered.size > LIMIT) remembered.delete(remembered.keys().next().value!);
	}
	return values;
}

/** Remembered lists, oldest first; a caller has a few (one per set of homes and variables it has seen). */
const remembered = new Map<string, { values: string[]; dirs: string[]; stamp: string }>();
const LIMIT = 32;

/** Forgets every remembered list (tests). */
export function forgetCanonicalPaths(): void {
	remembered.clear();
}

/** The directories the resolution of every file looks a name up in; undefined when one cannot be traced. */
function tracedDirs(files: readonly string[]): string[] | undefined {
	const dirs = new Set<string>();
	for (const file of files) if (!path.isAbsolute(file) || !traceInto(file, dirs)) return undefined;
	return [...dirs];
}

/**
 * Walks `file` from the root as the kernel resolves it, adding each directory a name is looked up in to `dirs`; the
 * walk stops at the first name that does not resolve. False when it cannot finish (more than 40 symlinks).
 */
function traceInto(file: string, dirs: Set<string>): boolean {
	const { root } = path.parse(file);
	const pending = segments(file.slice(root.length)).reverse();
	let current = root;
	let hops = 40;
	while (pending.length) {
		const segment = pending.pop()!;
		if (segment === "" || segment === ".") continue;
		// `current` holds no symlink, so its parent is the `..` the kernel takes.
		if (segment === "..") {
			current = path.dirname(current);
			continue;
		}
		dirs.add(current);
		const next = path.join(current, segment);
		let stat: fs.Stats | undefined;
		try {
			stat = fs.lstatSync(next, { throwIfNoEntry: false });
		} catch {
			// Not a directory or not searchable: decided by entries of `current`, already watched.
			return true;
		}
		if (!stat) return true;
		if (stat.isSymbolicLink()) {
			if (--hops < 0) return false;
			let target: string;
			try {
				target = fs.readlinkSync(next);
			} catch {
				return true;
			}
			if (path.isAbsolute(target)) current = path.parse(target).root;
			pending.push(...segments(target.slice(path.parse(target).root.length)).reverse());
			continue;
		}
		current = next;
	}
	return true;
}

const segments = (text: string): string[] => text.split(path.sep === "\\" ? /[\\/]+/ : /\/+/);

/** One string naming the state of `dirs`: device, inode, modification and change times, or `-` for a missing one. */
function stampOf(dirs: readonly string[]): string {
	let stamp = "";
	for (const dir of dirs) {
		let stat: fs.Stats | undefined;
		try {
			stat = fs.statSync(dir, { throwIfNoEntry: false });
		} catch {
			stat = undefined;
		}
		stamp += stat ? `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}|` : "-|";
	}
	return stamp;
}
