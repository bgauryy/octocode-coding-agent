import fs from "node:fs";
import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { getOctocodeHome } from "../../config.ts";
import { EXCLUDE_WORKSPACE_STATE, rejectTrackedWorkspaceState, git, gitQuiet, NO_HOOKS } from "../../utils/git-run.ts";
import { approveWorktree, type WorktreeTrustAsk } from "../worktrees/approval.ts";
import { linkDependencies } from "../worktrees/dependencies.ts";
import { copyIncluded } from "../worktrees/include.ts";
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
	const dirty = workingCopy ? "" : await git(repo, ["status", "--porcelain", "--", ...EXCLUDE_WORKSPACE_STATE]);
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
	const included = await copyIgnoredIncludes(repo, worktree);
	const dependencies = await linkIgnoredDependencies(repo, worktree);
	// `worktree add` does not fetch submodules (that would reach the network from URLs the branch names), so they are empty.
	const submodules = fs.existsSync(path.join(worktree, ".gitmodules"))
		? "The repository has submodules; they are empty in the isolated worktree (not initialised), so the subagent cannot build or test them."
		: "";
	const warnings = [
		dirty && !snapshot
			? "The main tree has uncommitted changes; the isolated subagent starts from HEAD without them."
			: "",
		submodules,
		included,
		dependencies,
	].filter(Boolean);
	return {
		agentId,
		repo,
		path: worktree,
		base,
		...(snapshot ? { snapshot } : {}),
		cwd: childCwd(repo, cwd, worktree),
		...(dependencies ? { unlinked: dependencies } : {}),
		...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
	};
}

/**
 * Recreates isolated child `agentId`'s worktree for a resume: at `at.path`, where `createWorktree` put it (so the paths in
 * its transcript stay valid), detached on `at.ref`, where its changes were saved. Once the owner record names the worktree
 * the ref is deleted: the worktree's HEAD holds the commit, and finishing (or a prune after a crash) saves it on the ref
 * again, under the same name. The base is where that commit meets this checkout's HEAD. Refuses when the ref is missing or
 * the path exists.
 */
export async function reopenWorktree(
	cwd: string,
	agentId: string,
	at: { ref: string; path: string },
	item?: string,
	ask?: WorktreeTrustAsk,
): Promise<Worktree> {
	if (!ID_PATTERN.test(agentId)) throw new Error(`Invalid agent id "${agentId}"`);
	const repo = repoRoot(cwd);
	if (fs.existsSync(at.path) || fs.existsSync(`${at.path}.json`))
		throw new Error(
			`${agentId}'s worktree ${at.path} already exists (kept when its changes could not be saved, or in use); save or remove it, then resume.`,
		);
	const head = await gitQuiet(repo, ["rev-parse", "--verify", "--quiet", `${at.ref}^{commit}`]);
	if (!head)
		throw new Error(
			`${agentId} has no saved changes on ${at.ref} (merged or discarded); start a new agent with the context it needs.`,
		);
	const main = await gitQuiet(repo, ["rev-parse", "--verify", "HEAD"]);
	const base = main && (await gitQuiet(repo, ["merge-base", head, main]));
	if (!base) throw new Error(`${at.ref} shares no commit with this checkout's HEAD; its worktree cannot be recreated.`);
	const recordTrust = await approveWorktree({ path: at.path, from: repo }, "worktree", ask);
	fs.mkdirSync(path.dirname(at.path), { recursive: true });
	atomicWriteFileSync(
		`${at.path}.json`,
		JSON.stringify({ owners: [owner(process.pid)], repo, base, ...(item ? { item } : {}), createdAt: Date.now() }),
	);
	try {
		await git(repo, [...NO_HOOKS, "worktree", "add", "--detach", at.path, head]);
	} catch (error) {
		fs.rmSync(`${at.path}.json`, { force: true });
		throw error;
	}
	await git(repo, ["update-ref", "-d", at.ref, head]);
	recordTrust();
	const included = await copyIgnoredIncludes(repo, at.path);
	const dependencies = await linkIgnoredDependencies(repo, at.path);
	const warning = [included, dependencies].filter(Boolean).join(" ");
	return {
		agentId,
		repo,
		path: at.path,
		base,
		cwd: childCwd(repo, cwd, at.path),
		...(dependencies ? { unlinked: dependencies } : {}),
		...(warning ? { warning } : {}),
	};
}

/** Where the child runs in `worktree`: the same subdirectory as the parent's `cwd` in `repo`, when the worktree has it. */
function childCwd(repo: string, cwd: string, worktree: string): string {
	const sub = path.relative(repo, path.resolve(cwd));
	return sub && !sub.startsWith("..") && fs.existsSync(path.join(worktree, sub)) ? path.join(worktree, sub) : worktree;
}

/**
 * Copies the checkout's `.worktreeinclude` files (typically `.env`) as `/worktree new` does, keeping only copies Git
 * ignores in the worktree: finishing commits every other untracked file into the child's result. Returns a warning
 * naming what was left out, or "".
 */
async function copyIgnoredIncludes(repo: string, worktree: string): Promise<string> {
	try {
		const { copied, skipped } = await copyIncluded(repo, worktree);
		const listed = copied.length ? await gitQuiet(worktree, ["check-ignore", "--", ...copied]) : undefined;
		// A path git quotes in its output does not match, so its copy is removed: the safe side.
		const ignored = new Set(listed?.split("\n"));
		const tracked = copied.filter((file) => !ignored.has(file));
		for (const file of tracked) fs.rmSync(path.join(worktree, file), { force: true });
		const left = [
			...skipped.filter((entry) => entry.reason !== "already exists").map((entry) => `${entry.path} (${entry.reason})`),
			...tracked.map((file) => `${file} (not ignored by Git, so the result would commit it)`),
		];
		return left.length > 0 ? `Not copied from .worktreeinclude: ${left.join(", ")}.` : "";
	} catch (error) {
		return `.worktreeinclude was not applied: ${errorMessage(error)}.`;
	}
}

/**
 * Links the checkout's ignored `node_modules` folders into the worktree (`linkDependencies`), after the
 * `.worktreeinclude` copies so a workspace link can point at a copied build. Returns a warning naming what was left out,
 * or "": the child then needs an install to build or test.
 */
async function linkIgnoredDependencies(repo: string, worktree: string): Promise<string> {
	try {
		const { skipped } = await linkDependencies(repo, worktree);
		const left = skipped.filter((entry) => entry.reason !== "already exists");
		return left.length > 0
			? `Not linked from the checkout's dependencies: ${left.map((entry) => `${entry.path} (${entry.reason})`).join(", ")}.`
			: "";
	} catch (error) {
		return `The checkout's node_modules folders were not linked, so builds and tests need an install: ${errorMessage(error)}.`;
	}
}
