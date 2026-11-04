import path from "node:path";
import { shortHash } from "../../../../common/src/atomic-file.ts";
import { HOME_NAMES, octocodeHome } from "./home.ts";
import { canonicalPath, isWithin, repoKey } from "./home/repo.ts";
import { WORKTREE_ROOT_ENV } from "./prompt-root.ts";

/**
 * The folder of every isolated worktree of the repository `cwd` belongs to. It is named by the repository's git
 * common directory, so the main checkout and each linked worktree share one folder, and a prune from any of them finds
 * the others' orphans.
 */
export function worktreesDir(cwd: string, home = octocodeHome()): string {
	return path.join(home, HOME_NAMES.worktrees, shortHash(repoKey(cwd).key));
}

/**
 * The isolated worktree this process runs in, canonical, or undefined. `OCTOCODE_WORKTREE_ROOT` alone proves nothing, since
 * any process can set it: it counts only when it names a direct child of the repository's own worktrees folder and `cwd`
 * is inside it. So a value naming the Octocode home, a folder under it, or a sibling's worktree grants nothing.
 */
export function ownWorktreeRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const named = env[WORKTREE_ROOT_ENV]?.trim();
	if (!named) return undefined;
	const root = canonicalPath(named);
	if (!isWithin(canonicalPath(cwd), root)) return undefined;
	return path.dirname(root) === canonicalPath(worktreesDir(root)) ? root : undefined;
}
