import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { git, GitError, gitQuiet, NO_HOOKS, rejectTrackedWorkspaceState } from "../shared/git.ts";
import { plural } from "../shared/render/text.ts";
import { dirtyCounts } from "./status.ts";
import { locateRepo } from "./repo.ts";
import { mainCheckout } from "./target.ts";

/** Why `ref` may not land: `reservation`'s refusal (another agent's lease) for each path it changes since its merge base with HEAD. */
export async function heldChanges(
	repo: string,
	ref: string,
	reservation: (absolute: string, display: string) => string | undefined,
): Promise<string[]> {
	const changed = (await gitQuiet(repo, ["diff", "--name-only", "--no-renames", `HEAD...${ref}`])) ?? "";
	return changed
		.split("\n")
		.filter(Boolean)
		.flatMap((file) => reservation(path.join(repo, file), file) ?? []);
}

/** Merges `ref` into the tree at `repo` with hooks disabled; on conflict aborts and lists the paths, leaving the tree and `ref` as they were. */
export async function mergeRef(repo: string, ref: string): Promise<{ ok: boolean; text: string; into?: string }> {
	if (await gitQuiet(repo, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]))
		return {
			ok: false,
			text: `A merge is already in progress. Finish or abort it before merging ${ref}; your resolution and ${ref} are kept.`,
		};
	try {
		await rejectTrackedWorkspaceState(repo, ref);
		await git(repo, [...NO_HOOKS, "merge", "--no-ff", "--no-edit", ref]);
	} catch (error) {
		const conflicts = (await gitQuiet(repo, ["diff", "--name-only", "--diff-filter=U"])) ?? "";
		if (await gitQuiet(repo, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])) {
			if ((await gitQuiet(repo, ["merge", "--abort"])) === undefined)
				return {
					ok: false,
					text: `Merging ${ref} failed and could not be aborted. The merge is still in progress; inspect git status before continuing. ${ref} is kept.\n${errorMessage(error)}`,
				};
		}
		if (conflicts)
			return {
				ok: false,
				text: `Merging ${ref} conflicts in:\n${conflicts}\nThe merge was aborted and the tree is unchanged; ${ref} is kept.`,
			};
		return { ok: false, text: `Merging ${ref} failed: ${errorMessage(error)}` };
	}
	return { ok: true, into: (await gitQuiet(repo, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "HEAD", text: "" };
}

/** The paths merging `branch` into HEAD would conflict in, without touching the tree; empty when git cannot say (before 2.38) and the merge itself decides. */
async function predictedConflicts(repo: string, branch: string): Promise<string[]> {
	try {
		await git(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "HEAD", branch]);
		return [];
	} catch (error) {
		if (!(error instanceof GitError) || error.exitCode !== 1) return [];
		return error.stdout.split("\n").slice(1).filter(Boolean);
	}
}

interface BranchMergePorts {
	/** Another agent's reservation of a path, as the file tool checks it. */
	reservation: (absolute: string, display: string) => string | undefined;
	/** The user's approval of exactly what the checks found; its refusal text, or undefined to go on. Unset when the user asked for this merge by typing it. */
	approve?: (what: string[]) => Promise<string | undefined>;
}

/**
 * Lands a linked worktree's branch in the main checkout, for the session that runs there: the worktree-finish workflow's
 * one write. It refuses, with the reason to send back, a session elsewhere, a branch no linked worktree holds, a worktree
 * with uncommitted work, a path another agent holds and a conflict, each before the user is asked, so an approval is for
 * a merge that can happen. It removes nothing: the worktree and its branch stay for their owner.
 */
export async function mergeWorktreeBranch(
	cwd: string,
	branch: string,
	ports: BranchMergePorts,
): Promise<{ ok: boolean; text: string }> {
	const refuse = (text: string) => ({ ok: false, text: `Not merged: ${text}` });
	const { folder: main, here } = await mainCheckout(cwd);
	if (!here)
		return refuse(
			"only the session in the main checkout merges. Send the request with `agent` type `message` to `coordinator`.",
		);
	const { entries } = await locateRepo(cwd);
	const linked = entries.slice(1).find((entry) => entry.branch === branch && !entry.prunable);
	if (!linked)
		return refuse(`no linked worktree of this repository holds a branch ${branch}; \`git worktree list\` shows them.`);
	const { dirty, untracked } = await dirtyCounts(linked.path);
	if (dirty + untracked > 0)
		return refuse(
			`${linked.path} has ${plural(dirty, "changed file")} and ${plural(untracked, "untracked file")} not on ${branch}. Ask its session to commit them or say they stay out, then send the request again.`,
		);
	const commits = await git(main, ["log", "--oneline", "--no-decorate", `HEAD..${branch}`]);
	if (!commits) return { ok: true, text: `Nothing to merge: ${branch} has no commits this checkout lacks.` };
	const held = await heldChanges(main, branch, ports.reservation);
	if (held.length > 0)
		return refuse(`${branch} changes files another agent holds. Merge after they are released.\n${held.join("\n")}`);
	const conflicts = await predictedConflicts(main, branch);
	if (conflicts.length > 0)
		return refuse(
			`${branch} conflicts in:\n${conflicts.join("\n")}\nThe tree is unchanged. Its session can merge this checkout's branch into ${branch}, resolve them and send the request again.`,
		);
	const count = commits.split("\n").length;
	const refused = await ports.approve?.([
		`branch ${branch} into the main checkout ${main}`,
		`from worktree ${linked.path}`,
		...commits.split("\n"),
	]);
	if (refused) return { ok: false, text: refused };
	const merged = await mergeRef(main, branch);
	if (!merged.ok) return merged;
	const head = await git(main, ["rev-parse", "--short", "HEAD"]);
	return {
		ok: true,
		text: `Merged ${branch} (${plural(count, "commit")}) into ${merged.into} at ${head}. The worktree ${linked.path} and its branch stay; its owner removes them with /worktree remove.`,
	};
}
