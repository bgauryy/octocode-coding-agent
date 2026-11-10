import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../../../../common/src/atomic-file.ts";
import { getOctocodeHome } from "../../config.ts";
import { EXCLUDE_WORKSPACE_STATE, rejectTrackedWorkspaceState, git, gitQuiet, NO_HOOKS } from "../../utils/git-run.ts";
import { approveWorktree, type WorktreeTrustAsk } from "../worktrees/approval.ts";
import { ID_PATTERN, owner, repoRoot, type Worktree, worktreesDir } from "./worktree-base.ts";
import { snapshotWorkingCopy } from "./worktree-snapshot.ts";

/**
 * Creates a detached worktree at HEAD, or at an explicit snapshot of the current working files, under the repository's
 * shared worktrees folder. `item` (the backlog item the child works on) is kept in the owner record, so a prune that
 * saves the child's changes later can still tell the item. The repository's hooks never run (no `post-checkout`).
 */
export async function createWorktree(
	cwd: string,
	agentId: string,
	home = getOctocodeHome(),
	workingCopy = false,
	item?: string,
	ask?: WorktreeTrustAsk,
): Promise<Worktree> {
	if (!ID_PATTERN.test(agentId)) throw new Error(`Invalid agent id "${agentId}"`);
	const repo = repoRoot(cwd);
	const base = await gitQuiet(repo, ["rev-parse", "--verify", "HEAD"]);
	if (!base) throw new Error("isolate needs at least one commit to start the worktree from.");
	await rejectTrackedWorkspaceState(repo, base);
	const dirty = workingCopy ? "" : await git(repo, ["status", "--porcelain", "--", EXCLUDE_WORKSPACE_STATE]);
	const dir = worktreesDir(repo, home);
	const worktree = path.join(dir, agentId);
	// Settled before anything is created, so a "No" leaves nothing behind.
	const recordTrust = await approveWorktree({ path: worktree, from: repo }, "worktree", ask);
	fs.mkdirSync(dir, { recursive: true });
	// Never reuse a kept worktree's id: overwriting (then removing) its record would hide it from prune and reports.
	if (fs.existsSync(worktree) || fs.existsSync(`${worktree}.json`))
		throw new Error(`A worktree for ${agentId} already exists at ${worktree}; start the agent again for a new id.`);
	const snapshot = workingCopy ? await snapshotWorkingCopy(repo, base) : undefined;
	// The owner record lets a later session prune worktrees whose parent process died.
	atomicWriteFileSync(
		`${worktree}.json`,
		JSON.stringify({
			owners: [owner(process.pid)],
			repo,
			base,
			...(snapshot ? { snapshot } : {}),
			...(item ? { item } : {}),
			createdAt: Date.now(),
		}),
	);
	try {
		await git(repo, [...NO_HOOKS, "worktree", "add", "--detach", worktree, snapshot ?? base]);
	} catch (error) {
		fs.rmSync(`${worktree}.json`, { force: true });
		throw error;
	}
	recordTrust();
	// `worktree add` does not fetch submodules (that would reach the network from URLs the branch names), so they are empty.
	const submodules = fs.existsSync(path.join(worktree, ".gitmodules"))
		? "The repository has submodules; they are empty in the isolated worktree (not initialised), so the subagent cannot build or test them."
		: "";
	const warnings = [
		dirty && !snapshot
			? "The main tree has uncommitted changes; the isolated subagent starts from HEAD without them."
			: "",
		submodules,
	].filter(Boolean);
	const sub = path.relative(repo, path.resolve(cwd));
	const childCwd =
		sub && !sub.startsWith("..") && fs.existsSync(path.join(worktree, sub)) ? path.join(worktree, sub) : worktree;
	return {
		agentId,
		repo,
		path: worktree,
		base,
		...(snapshot ? { snapshot } : {}),
		cwd: childCwd,
		...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
	};
}
