import path from "node:path";
import { canonicalPath, repoKey } from "../../shared/home/repo.ts";
import { TEAM_WORKSPACE_ENV } from "../../shared/env.ts";
import { leaseKey } from "../lease-key.ts";

/**
 * The team workspace for `cwd`: one team per repository (`repoKey(cwd).root`, symlinks resolved), unless
 * `TEAM_WORKSPACE_ENV` names it (a subagent in an isolated worktree joins its parent's team).
 */
export function teamWorkspace(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const override = env[TEAM_WORKSPACE_ENV];
	if (override && path.isAbsolute(override)) return canonicalPath(override);
	return repoKey(cwd).root;
}

/**
 * `file` (absolute, or relative to `workspace`) with symlinks resolved. The path is not normalised first: a `..` after a
 * symlink names the link target's parent, as the shell and the kernel read it (see `canonicalPath`).
 */
export function canonicalIn(workspace: string, file: string): string {
	return canonicalPath(path.isAbsolute(file) ? file : `${workspace}${path.sep}${file}`);
}

/**
 * Canonical comparison key of `file` below `workspace`: its components folded as `lease-key.ts` says (the rules the
 * agents-communication package shares), so `Src/A.ts` and `src/a.ts` collide on every platform.
 */
export function pathKey(workspace: string, file: string): string {
	const relative = path.relative(workspace, canonicalIn(workspace, file));
	return leaseKey(relative.split(path.sep));
}
