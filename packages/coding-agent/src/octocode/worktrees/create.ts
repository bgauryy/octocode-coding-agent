import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { git, gitQuiet } from "../shared/git.ts";
import { approveWorktree, type WorktreeTrustAsk } from "./approval.ts";
import { copyIncluded, type IncludeResult } from "./include.ts";
import { worktreeBranch, worktreeNameProblem } from "./name.ts";
import { branchExists, entryAt, locateRepo, worktreePath } from "./repo.ts";

export interface WorktreeInfo {
	name: string;
	/** The main worktree's root the folder lives under. */
	main: string;
	path: string;
	/** The branch checked out there: `worktree-<name>` for a new one, whatever it is on for a reused one; absent when detached. */
	branch?: string;
	/** False when the worktree already existed and was reused. */
	created: boolean;
	/** What `.worktreeinclude` carried over (empty on reuse). */
	include: IncludeResult;
}

/**
 * Creates `<main root>/.octocode/worktrees/<name>` on branch `worktree-<name>` started at the HEAD of the checkout
 * `cwd` is in, or reuses the worktree (or the branch) when it exists. Git runs its hooks as it does for a manual
 * `git worktree add`: the user asked for this worktree. Rejects with a message fit to show when `name` is invalid,
 * `cwd` is not in a repository, or the repository has no commit. Before it creates one it settles folder trust for the
 * new folder (`approval.ts`: asked through `ask`, or allowed by `--trust`), so a refusal creates nothing; one it reuses
 * keeps whatever trust it has.
 */
export async function ensureWorktree(cwd: string, name: string, ask?: WorktreeTrustAsk): Promise<WorktreeInfo> {
	const problem = worktreeNameProblem(name);
	if (problem) throw new Error(problem);
	const repo = await locateRepo(cwd);
	const target = worktreePath(repo.main, name);
	const branch = worktreeBranch(name);
	const existing = entryAt(repo.entries, target);
	const none: IncludeResult = { copied: [], skipped: [] };

	if (existing && !existing.prunable && existsSync(target))
		return {
			name,
			main: repo.main,
			path: target,
			...(existing.branch ? { branch: existing.branch } : {}),
			created: false,
			include: none,
		};
	if (!(await gitQuiet(repo.checkout, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])))
		throw new Error("This repository has no commits yet: commit once so the worktree has something to start from.");
	if (existing) await git(repo.main, ["worktree", "prune"]); // registered, but its folder is gone
	else if (existsSync(target))
		throw new Error(`${target} exists but is not a git worktree of this repository; move or delete it first.`);

	const recordTrust = await approveWorktree({ path: target, from: repo.main }, "worktree", ask);
	await mkdir(path.dirname(target), { recursive: true });
	// Started from the checkout's HEAD; a branch of that name from an earlier worktree is resumed as it is.
	const add = (await branchExists(repo.main, name))
		? ["worktree", "add", target, branch]
		: ["worktree", "add", "-b", branch, target, "HEAD"];
	try {
		await git(repo.checkout, add);
	} catch (error) {
		throw new Error(`Could not create worktree "${name}": ${errorMessage(error)}`);
	}
	recordTrust();
	const include = await copyIncluded(repo.checkout, target);
	return { name, main: repo.main, path: target, branch, created: true, include };
}

/** One line saying what `ensureWorktree` did. */
export function describeWorktree(info: WorktreeInfo): string {
	const verb = info.created ? "Created" : "Using existing";
	const copied = info.include.copied.length;
	const extra = copied > 0 ? `; copied ${copied} file${copied === 1 ? "" : "s"} from .worktreeinclude` : "";
	return `${verb} worktree ${info.name} (${info.branch ? `branch ${info.branch}` : "detached HEAD"}) at ${info.path}${extra}`;
}
