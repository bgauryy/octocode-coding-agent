import { gitQuiet } from "../../utils/git-run.ts";
import { locateRepo } from "./repo.ts";

/**
 * Whether a git call in `dir` acts on the main checkout (the first entry of `git worktree list`) while it is on the
 * repository's default branch: `origin/HEAD`, else `main` or `master`. `switchedTo` is the branch the same command line
 * moved it to first (`git switch main && git merge x`), which counts when the line creates it or a ref has that name.
 * Undefined when it does not, and when git cannot say: not a repository, a bare one, a detached HEAD or no way to name
 * the default branch.
 */
export async function protectedBranch(
	dir: string,
	switchedTo?: { name: string; created: boolean },
): Promise<{ branch: string; checkout: string } | undefined> {
	const repo = await locateRepo(dir).catch(() => undefined);
	if (!repo || repo.checkout !== repo.main) return undefined;
	const switched =
		switchedTo &&
		(switchedTo.created ||
			(await gitQuiet(repo.main, ["rev-parse", "--verify", "--quiet", `refs/heads/${switchedTo.name}`])) !== undefined);
	const branch = switched ? switchedTo.name : repo.entries[0]?.branch;
	if (!branch) return undefined;
	const remote = await gitQuiet(repo.main, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
	const isDefault = remote ? remote === `refs/remotes/origin/${branch}` : branch === "main" || branch === "master";
	return isDefault ? { branch, checkout: repo.main } : undefined;
}
