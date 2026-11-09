import fs from "node:fs";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import {
	EXCLUDE_WORKSPACE_STATE,
	WORKSPACE_STATE_PATHSPEC,
	rejectTrackedWorkspaceState,
	git,
	gitQuiet,
	NO_HOOKS,
} from "../../utils/git-run.ts";
import { revokeWorktreeGrant } from "../trust/grants.ts";
import { REF_PREFIX, type Worktree, type WorktreeResult } from "./worktree-base.ts";
import {
	PLAIN_DIFF,
	recoverWorktreeBase,
	rejectChangedFilters,
	rejectNestedRepositories,
	saveWorkerRef,
	validateSnapshot,
	workerDeltaCommit,
} from "./worktree-snapshot.ts";

type Finishing = Pick<Worktree, "agentId" | "repo" | "path" | "base" | "snapshot">;

/**
 * Commits whatever changed in the worktree to the agent's private ref, then removes the worktree. The worktree is
 * removed only once its changes are safe on the ref (or it changed nothing); when saving fails it is kept, with its
 * owner record, and the error names where it is.
 */
export async function finishWorktree(worktree: Finishing): Promise<WorktreeResult> {
	if (!fs.existsSync(worktree.path)) {
		await removeWorktree(worktree);
		return {};
	}
	if (fs.lstatSync(worktree.path).isSymbolicLink())
		throw new Error(`Worktree path is a symbolic link: ${worktree.path}`);
	let result: WorktreeResult;
	try {
		result = await saveChanges(worktree);
	} catch (error) {
		throw new Error(
			`${errorMessage(error)}. The worktree is kept at ${worktree.path}; commit or copy its changes, then remove it with \`git worktree remove --force ${worktree.path}\`.`,
			{ cause: error },
		);
	}
	await removeWorktree(worktree);
	return result;
}

async function saveChanges(worktree: Finishing): Promise<WorktreeResult> {
	// Before `status`, which also runs a clean filter to tell whether a changed file really differs.
	await rejectTrackedWorkspaceState(worktree.path, "HEAD");
	await rejectChangedFilters(worktree.path);
	if (await git(worktree.path, ["status", "--porcelain", "--", EXCLUDE_WORKSPACE_STATE])) {
		await git(worktree.path, ["add", "-A", "--", EXCLUDE_WORKSPACE_STATE]);
		const identity = (await gitQuiet(worktree.path, ["config", "user.email"]))
			? []
			: ["-c", "user.name=Octocode", "-c", "user.email=octocode@localhost"];
		await git(worktree.path, [
			...NO_HOOKS,
			...identity,
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--no-verify",
			"-q",
			"-m",
			`octocode subagent ${worktree.agentId}`,
		]);
		// Anything still uncommitted (a failed partial commit) would be lost with the worktree.
		if (await git(worktree.path, ["status", "--porcelain", "--", EXCLUDE_WORKSPACE_STATE]))
			throw new Error("Uncommitted changes remain after the commit");
	}
	const head = await git(worktree.path, ["rev-parse", "HEAD"]);
	const base = worktree.base || (await recoverWorktreeBase(worktree.repo, head));
	await validateSnapshot(worktree.repo, base, worktree.snapshot, head);
	if (head === (worktree.snapshot ?? base)) return {};
	if (
		await git(worktree.repo, [
			"log",
			"-1",
			"--format=%H",
			`${worktree.snapshot ?? base}..${head}`,
			"--",
			WORKSPACE_STATE_PATHSPEC,
		])
	)
		throw new Error("A worktree commit includes private workspace state under .octocode/code");
	await rejectNestedRepositories(worktree.repo, worktree.snapshot ?? base, head);
	const { commit, conflict } = worktree.snapshot
		? await workerDeltaCommit(worktree.repo, base, worktree.snapshot, head, worktree.agentId)
		: { commit: head, conflict: undefined };
	if (commit === base) return {};
	const ref = await saveWorkerRef(worktree.repo, `${REF_PREFIX}${worktree.agentId}`, commit);
	const stat = await git(worktree.repo, ["diff", ...PLAIN_DIFF, "--stat", base, commit]);
	return conflict ? { ref, stat, conflict } : { ref, stat };
}

async function removeWorktree(worktree: Pick<Worktree, "repo" | "path">): Promise<void> {
	if ((await gitQuiet(worktree.repo, ["worktree", "remove", "--force", worktree.path])) === undefined) {
		fs.rmSync(worktree.path, { recursive: true, force: true });
		await gitQuiet(worktree.repo, ["worktree", "prune"]);
	}
	fs.rmSync(`${worktree.path}.json`, { force: true });
	revokeWorktreeGrant(worktree.path);
}

/** The lines appended to an isolated subagent's report. */
export function isolationReport(agentId: string, result: WorktreeResult | { error: string }): string {
	if ("error" in result) return `\n\nIsolated worktree for ${agentId} could not be saved: ${result.error}`;
	if (!result.ref) return `\n\nIsolated run ${agentId} changed no files.`;
	if (result.conflict)
		return `\n\nIsolated changes are saved on ${result.ref}, but they did not apply to the commit the run started from: ${result.conflict.reason}\nThe ref is the child's own head, built on a snapshot of the parent's uncommitted files, so its diff includes those edits:\n${result.stat}\nIts own change is the patch ${result.conflict.patch}. Merging ${result.ref} may conflict: resolve it, or apply the patch by hand (\`git apply --3way\`). Merge with \`agent\` type \`coordinate\`, action \`merge\`, subagent \`${result.ref.slice(REF_PREFIX.length)}\`; it lists the conflicting files and leaves the ref.`;
	return `\n\nIsolated changes are on ${result.ref}, not in this tree:\n${result.stat}\nMerge with \`agent\` type \`coordinate\`, action \`merge\`, subagent \`${result.ref.slice(REF_PREFIX.length)}\` (the user: \`/agents merge ${result.ref.slice(REF_PREFIX.length)}\`), not \`git merge\`: it checks reservations, removes the ref and notes the merge on the item.`;
}
