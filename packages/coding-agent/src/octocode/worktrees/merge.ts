import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { Member } from "@octocodeai/octocode-contracts/team";
import { git, GitError, gitQuiet, NO_HOOKS, rejectTrackedWorkspaceState } from "../../utils/git-run.ts";
import { plural } from "../shared/text.ts";
import { dirtyCounts } from "./status.ts";
import { canonical, locateRepo } from "./repo.ts";
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
	/** The team's live agents: one still working in the worktree means its branch is not finished. */
	occupants?: () => readonly Member[];
	/** The backlog items the sessions `sessions` hold on the board of `worktree` that are not done (`B3 (ongoing)`): work on the branch is still open. */
	openItems?: (worktree: string, sessions: string[]) => string[];
}

/** A merge that happened: what landed where, for whoever announces it. */
export interface BranchMerged {
	branch: string;
	into: string;
	head: string;
	commits: number;
	worktree: string;
}

/**
 * Lands a linked worktree's branch in the main checkout, for the session that runs there: the worktree-finish workflow's
 * one write. Its readiness check refuses, with the reason and the next step to send back, a session elsewhere, a branch
 * no linked worktree holds, a worktree with uncommitted work, an agent still working there, an open backlog item a
 * session there holds on that worktree's board, a path another agent holds and a conflict git predicts (`merge-tree`),
 * each before the user is asked, so an approval (or bypass mode, which asks nobody) is for a merge that can happen. The
 * cheap checks (uncommitted work, an agent working there) run again once the dialog is answered, since it can wait. It
 * removes nothing: the worktree and its branch stay for their owner.
 */
export async function mergeWorktreeBranch(
	cwd: string,
	branch: string,
	ports: BranchMergePorts,
): Promise<{ ok: boolean; text: string; merged?: BranchMerged }> {
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
	const dirtyWork = async () => {
		const { dirty, untracked } = await dirtyCounts(linked.path);
		return dirty + untracked > 0
			? `${linked.path} has ${plural(dirty, "changed file")} and ${plural(untracked, "untracked file")} not on ${branch}. Ask its session to commit them or say they stay out, then send the request again.`
			: undefined;
	};
	const owners = () => (ports.occupants?.() ?? []).filter((member) => member.checkout === canonical(linked.path));
	const stillWorking = () => {
		const working = owners()
			.filter((member) => member.status === "working")
			.map((member) => member.id);
		return working.length > 0
			? `${working.join(", ")} ${working.length > 1 ? "are" : "is"} still working in ${linked.path}. Wait until ${working.length > 1 ? "they are" : "it is"} idle or gone (\`agent\` type \`coordinate\`, action \`list\` shows it), then send the request again.`
			: undefined;
	};
	const dirtyBefore = await dirtyWork();
	if (dirtyBefore) return refuse(dirtyBefore);
	const commits = await git(main, ["log", "--oneline", "--no-decorate", `HEAD..${branch}`]);
	if (!commits) return { ok: true, text: `Nothing to merge: ${branch} has no commits this checkout lacks.` };
	const workingBefore = stillWorking();
	if (workingBefore) return refuse(workingBefore);
	const sessions = owners().flatMap((member) => (member.sessionId ? [member.sessionId] : []));
	const open = ports.openItems?.(linked.path, sessions) ?? [];
	if (open.length > 0)
		return refuse(
			`backlog work on ${branch} is not done: ${open.join(", ")}. Ask its session to finish it (backlog done) or to drop it, then send the request again.`,
		);
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
	// The dialog can wait: what changed while it did is checked again before anything lands.
	const changedMeanwhile = stillWorking() ?? (await dirtyWork());
	if (changedMeanwhile) return refuse(changedMeanwhile);
	const merged = await mergeRef(main, branch);
	if (!merged.ok) return merged;
	const head = await git(main, ["rev-parse", "--short", "HEAD"]);
	const into = merged.into ?? "HEAD";
	return {
		ok: true,
		text: `Merged ${branch} (${plural(count, "commit")}) into ${into} at ${head}. The worktree ${linked.path} and its branch stay; its owner removes them with /worktree remove.`,
		merged: { branch, into, head, commits: count, worktree: linked.path },
	};
}
