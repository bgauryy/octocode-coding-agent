import { git, gitQuiet } from "../shared/git.ts";
import { revokeWorktreeGrant } from "../trust/grants.ts";
import { worktreeBranch, worktreeNameProblem } from "./name.ts";
import { entryAt, locateRepo, worktreePath } from "./repo.ts";
import { dirtyCounts, insideWorktree, unmergedCount } from "./status.ts";

export interface RemoveResult {
	removed: boolean;
	/** What happened or what blocks, ready to show. */
	message: string;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

export interface RemoveOptions {
	force?: boolean;
	sessionCwd?: string;
	/**
	 * Who is working in `target`, given every live worktree root: `agents: …; tmux: …` or nothing. Without `force` a
	 * worktree with occupants stays.
	 */
	occupants?: (target: string, roots: string[]) => Promise<string | undefined>;
}

/**
 * Removes `<main root>/.octocode/worktrees/<name>`. Without `force` it refuses a worktree with changed or untracked
 * files, with commits no other branch has, or with occupants (`options.occupants`), and says which. It never removes the worktree `sessionCwd` is in. The
 * branch goes only through `git branch -d`, so an unmerged one stays.
 */
export async function removeWorktree(cwd: string, name: string, options: RemoveOptions = {}): Promise<RemoveResult> {
	const problem = worktreeNameProblem(name);
	if (problem) return { removed: false, message: problem };
	const repo = await locateRepo(cwd);
	const target = worktreePath(repo.main, name);
	const entry = entryAt(repo.entries, target);
	if (!entry) return { removed: false, message: `No worktree "${name}" under ${worktreePath(repo.main, "")}.` };
	if (insideWorktree(options.sessionCwd ?? cwd, target))
		return { removed: false, message: `This session runs in worktree "${name}"; remove it from another checkout.` };

	if (!entry.prunable && !options.force) {
		const roots = repo.entries.filter((candidate) => !candidate.prunable).map((candidate) => candidate.path);
		const here = await options.occupants?.(target, roots);
		if (here)
			return {
				removed: false,
				message: `Worktree "${name}" is in use (${here}). Close them, or run /worktree remove ${name} --force.`,
			};
		const { dirty, untracked } = await dirtyCounts(target);
		const unmerged = await unmergedCount(entry);
		const blockers = [
			dirty > 0 ? `${plural(dirty, "changed file")}` : "",
			untracked > 0 ? `${plural(untracked, "untracked file")}` : "",
			unmerged > 0 ? `${plural(unmerged, "commit")} not on any other branch` : "",
		].filter(Boolean);
		if (blockers.length > 0)
			return {
				removed: false,
				message: `Worktree "${name}" has ${blockers.join(", ")}. Run /worktree remove ${name} --force to discard them.`,
			};
	}

	// A registered worktree whose folder is gone has nothing to remove: pruning drops the entry.
	await git(
		repo.main,
		entry.prunable ? ["worktree", "prune"] : ["worktree", "remove", ...(options.force ? ["--force"] : []), target],
	);
	revokeWorktreeGrant(target); // the grant of a worktree that no longer exists
	const branch = worktreeBranch(name);
	if (entry.branch !== branch) return { removed: true, message: `Removed worktree "${name}".` };
	const deleted = await gitQuiet(repo.main, ["branch", "-d", branch]);
	return {
		removed: true,
		message:
			deleted === undefined
				? `Removed worktree "${name}". Kept branch ${branch}: it has commits that are not merged (delete it with git branch -D ${branch}).`
				: `Removed worktree "${name}" and its branch ${branch}.`,
	};
}
