import path from "node:path";
import { gitMarkerDir } from "../../../utils/git-marker.ts";

export { canonicalPath } from "../../../../../common/src/canonical-path.ts";
export { repoKey, workspaceRoot } from "../../../utils/git-repository.ts";

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
