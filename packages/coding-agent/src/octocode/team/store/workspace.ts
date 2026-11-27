import path from "node:path";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { repoKey } from "../../../utils/git-repository.ts";
import { sessionWorkspace } from "../../shared/home/workspace.ts";
import { leaseKey } from "../lease-key.ts";

/**
 * The checkout `cwd` works in: its worktree root (`repoKey(cwd).root`, symlinks resolved), unless `TEAM_WORKSPACE_ENV`
 * names it (a subagent in an isolated worktree uses its parent's checkout). It scopes what names files: leases, the edit
 * log, scratch folders and lock advice. Worktrees of one repository are different checkouts of one team (`teamScope`).
 */
export function teamWorkspace(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	return sessionWorkspace(cwd, env);
}

/**
 * The team of `cwd`: one per repository, named by the git common dir (`repoKey(...).key`), which every worktree of it
 * shares. The checkout is resolved first, so an isolated subagent with `TEAM_WORKSPACE_ENV` is on its parent's team. It
 * scopes agents, messages and deliveries, so agents in sibling worktrees see and message each other.
 */
export function teamScope(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	return repoKey(teamWorkspace(cwd, env)).key;
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
