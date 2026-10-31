import { innermostWorktree } from "./occupants.ts";
import { worktreeNameProblem } from "./name.ts";
import { canonical, entryAt, locateRepo, worktreePath } from "./repo.ts";

/**
 * The existing worktree `name` (made by `/worktree new`, under `.octocode/worktrees`) of the repository `cwd` is in: its
 * folder, and whether `cwd` is already inside it. Rejects with the reason and what to run next when the name is invalid,
 * no such worktree exists, or its folder is gone.
 */
export async function existingWorktree(cwd: string, name: string): Promise<{ folder: string; here: boolean }> {
	const problem = worktreeNameProblem(name);
	if (problem) throw new Error(problem);
	const repo = await locateRepo(cwd);
	const entry = entryAt(repo.entries, worktreePath(repo.main, name));
	if (!entry)
		throw new Error(`No worktree named ${name}. /worktree list shows them; /worktree new ${name} creates one.`);
	if (entry.prunable)
		throw new Error(`The folder of worktree ${name} is missing: run git worktree prune, then /worktree new ${name}.`);
	const roots = repo.entries.filter((candidate) => !candidate.prunable).map((candidate) => candidate.path);
	const current = innermostWorktree(roots, cwd);
	return { folder: entry.path, here: current !== undefined && canonical(current) === canonical(entry.path) };
}
