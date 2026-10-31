import { ensureWorktree, type WorktreeInfo } from "./create.ts";

/**
 * Creates or reuses worktree `name`, then makes it the process directory, so settings, trust, sessions and team all see
 * the worktree. Rejects before changing anything when the name is invalid or the directory is not in a repository.
 * The CLI startup that calls this is `cli/worktree-startup.ts`.
 */
export async function enterWorktree(name: string, cwd = process.cwd()): Promise<WorktreeInfo> {
	const info = await ensureWorktree(cwd, name);
	process.chdir(info.path);
	return info;
}
