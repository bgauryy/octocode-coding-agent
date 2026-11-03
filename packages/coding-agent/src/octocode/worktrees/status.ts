import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { isWithin } from "../shared/home/repo.ts";
import { EXCLUDE_WORKSPACE_STATE, git } from "../shared/git.ts";
import { canonical, locateRepo, worktreesFolder, type WorktreeEntry } from "./repo.ts";

export interface WorktreeStatus {
	entry: WorktreeEntry;
	/** Name under `.octocode/worktrees`; undefined for the main worktree and for worktrees made elsewhere. */
	name?: string;
	main: boolean;
	/** Tracked files changed or staged. */
	dirty: number;
	untracked: number;
	/** Commits reachable from this worktree's HEAD and from no other branch. Not counted for the main worktree. */
	unmerged: number;
	/** Why git could not read this worktree's state (a corrupt index, say); the counts are then 0. */
	error?: string;
}

/** Counts of changed and untracked files in the worktree at `dir`. */
export async function dirtyCounts(dir: string): Promise<{ dirty: number; untracked: number }> {
	const out = await git(
		dir,
		["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", EXCLUDE_WORKSPACE_STATE],
		{ raw: true },
	);
	let dirty = 0;
	let untracked = 0;
	const fields = out.split("\0");
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i] ?? "";
		if (!field) continue;
		if (field.startsWith("??")) untracked++;
		else dirty++;
		if (field[0] === "R" || field[0] === "C") i++; // a rename lists its source as a second field
	}
	return { dirty, untracked };
}

/** Commits of the worktree's HEAD that no other local or remote branch contains. */
export async function unmergedCount(entry: WorktreeEntry): Promise<number> {
	const others = entry.branch ? [`--exclude=${entry.branch}`, "--branches"] : ["--branches"];
	const out = await git(entry.path, ["rev-list", "--count", "HEAD", "--not", ...others, "--remotes"]);
	return Number(out) || 0;
}

/** The repository's worktrees with their state: the main one first, then those under `.octocode/worktrees`, then others. */
export async function worktreeStatuses(cwd: string): Promise<{ main: string; statuses: WorktreeStatus[] }> {
	const repo = await locateRepo(cwd);
	const folder = canonical(worktreesFolder(repo.main));
	const statuses = await Promise.all(
		repo.entries.map(async (entry, index): Promise<WorktreeStatus> => {
			const real = canonical(entry.path);
			const name = path.dirname(real) === folder ? path.basename(real) : undefined;
			const base = { entry, main: index === 0, ...(name ? { name } : {}) };
			if (entry.prunable) return { ...base, dirty: 0, untracked: 0, unmerged: 0 };
			try {
				const counts = await dirtyCounts(entry.path);
				return { ...base, ...counts, unmerged: index === 0 ? 0 : await unmergedCount(entry) };
			} catch (error) {
				// One worktree git cannot read must not hide the others.
				const reason = errorMessage(error).split("\n")[0]?.trim() || "git failed";
				return { ...base, dirty: 0, untracked: 0, unmerged: 0, error: reason };
			}
		}),
	);
	const rank = (status: WorktreeStatus) => (status.main ? 0 : status.name ? 1 : 2);
	return { main: repo.main, statuses: statuses.sort((a, b) => rank(a) - rank(b)) };
}

/** Whether `dir` is `target` or inside it. */
export const insideWorktree = (dir: string, target: string): boolean => isWithin(canonical(dir), canonical(target));
