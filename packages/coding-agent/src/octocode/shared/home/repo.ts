import path from "node:path";

export { canonicalPath } from "../../../../../common/src/canonical-path.ts";
export { repoKey, workspaceRoot } from "../../../utils/git-repository.ts";
export { dirsToRepoRoot } from "../../../utils/repo-dirs.ts";

/** Whether `file` is `dir` or under it (both already resolved; no symlinks are followed here). */
export function isWithin(file: string, dir: string): boolean {
	const relative = path.relative(dir, file);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
