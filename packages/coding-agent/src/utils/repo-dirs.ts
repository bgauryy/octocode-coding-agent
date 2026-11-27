import path from "node:path";
import { gitMarkerDir } from "./git-marker.ts";

/**
 * `cwd` and its ancestors up to the repository root (the nearest directory holding `.git`), nearest first; just
 * `cwd` outside a repository.
 */
export function dirsToRepoRoot(cwd: string): string[] {
	return walkUp(cwd, false);
}

/**
 * `cwd` and its ancestors up to the repository root, nearest first; outside a repository, up to the filesystem root (the
 * shared `.agents/skills` convention).
 */
export function dirsToRepoOrFsRoot(cwd: string): string[] {
	return walkUp(cwd, true);
}

function walkUp(cwd: string, outsideToFsRoot: boolean): string[] {
	const root = gitMarkerDir(cwd);
	if (root === undefined && !outsideToFsRoot) return [path.resolve(cwd)];
	const dirs: string[] = [];
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		dirs.push(dir);
		if (dir === root || path.dirname(dir) === dir) return dirs;
	}
}
