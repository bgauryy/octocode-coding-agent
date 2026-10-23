import path from "node:path";
import { canonicalPath, repoKey } from "../../shared/home.ts";
import { leaseKey } from "../lease-key.ts";
import { TEAM_WORKSPACE_ENV } from "./env.ts";

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
 * Canonical comparison key of `file` below `workspace`: its components folded as `lease-key.ts` says (the rules the
 * agents-communication package shares), so `Src/A.ts` and `src/a.ts` collide on every platform.
 */
export function pathKey(workspace: string, file: string): string {
	const relative = path.relative(workspace, canonicalPath(path.resolve(workspace, file)));
	return leaseKey(relative.split(path.sep));
}
