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
import { copyIgnoredOutputs, outputsReport } from "./worktree-outputs.ts";
import { REF_PREFIX, type Worktree, type WorktreeResult } from "./worktree-base.ts";
import {
	PLAIN_DIFF,
	recoverWorktreeBase,
	rejectChangedFilters,
	rejectNestedRepositories,
	rejectOutsideLinks,
	saveWorkerRef,
	validateSnapshot,
	workerDeltaCommit,
} from "./worktree-snapshot.ts";

type Finishing = Pick<Worktree, "agentId" | "repo" | "path" | "base" | "snapshot">;

/**
 * Commits whatever changed in the worktree to the agent's private ref, copies the child's git-ignored outputs under
 * `.octocode/` to the checkout (`copyIgnoredOutputs`), then removes the worktree. The worktree is removed only once its
 * changes are safe on the ref (or it changed nothing) and those outputs are in the checkout; when saving or copying
 * fails it is kept, with its owner record, and the error names where it is.
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
		const outputs = await copyIgnoredOutputs(worktree);
		if (outputs.copied.length > 0 || outputs.conflicts.length > 0 || outputs.dropped) result = { ...result, outputs };
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
	if (await git(worktree.path, ["status", "--porcelain", "--", ...EXCLUDE_WORKSPACE_STATE])) {
		await git(worktree.path, ["add", "-A", "--", ...EXCLUDE_WORKSPACE_STATE]);
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
		if (await git(worktree.path, ["status", "--porcelain", "--", ...EXCLUDE_WORKSPACE_STATE]))
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
			...WORKSPACE_STATE_PATHSPEC,
		])
	)
		throw new Error("A worktree commit includes private workspace state under .octocode/agent");
	await rejectNestedRepositories(worktree.repo, worktree.snapshot ?? base, head);
	await rejectOutsideLinks(worktree.repo, worktree.snapshot ?? base, head);
	const { commit, conflict } = worktree.snapshot
		? await workerDeltaCommit(worktree.repo, base, worktree.snapshot, head, worktree.agentId)
		: { commit: head, conflict: undefined };
	if (commit === base) return {};
	const ref = await saveWorkerRef(worktree.repo, `${REF_PREFIX}${worktree.agentId}`, commit);
	// The child's own change: from the commit it started on (the parent's snapshot, if any) to its head, so a
	// conflicted ref built on that snapshot does not list the parent's uncommitted edits as the child's.
	const stat = capStat(await git(worktree.repo, ["diff", ...PLAIN_DIFF, "--stat", worktree.snapshot ?? base, head]));
	return conflict ? { ref, stat, conflict } : { ref, stat };
}

/** Files a report's diffstat lists before `+N more files`. */
const STAT_FILES = 20;

/** `git diff --stat` cut to its first `STAT_FILES` file rows, a `+N more files` row and the summary line. */
export function capStat(stat: string): string {
	const rows = stat.split("\n");
	if (rows.length <= STAT_FILES + 1) return stat;
	const summary = rows.at(-1) ?? "";
	const more = rows.length - 1 - STAT_FILES;
	return [...rows.slice(0, STAT_FILES), ` +${more} more files`, summary].join("\n");
}

/**
 * The files `git apply --3way` could not apply, read from its stderr (`error: patch failed: a.ts:12`,
 * `error: a.ts: does not apply`, `U a.ts`); its progress lines (`Falling back to direct application...`) are dropped.
 * The first line stands in when no file is named.
 */
export function conflictFiles(reason: string): string {
	const files = new Set<string>();
	for (const line of reason.split("\n")) {
		const named =
			/^error: patch failed: (.+):\d+$/u.exec(line)?.[1] ??
			/^error: (.+): does not (?:apply|exist in index)$/u.exec(line)?.[1] ??
			/^U (.+)$/u.exec(line)?.[1];
		if (named) files.add(named);
	}
	return files.size > 0 ? [...files].join(", ") : (reason.split("\n").find((line) => line.trim()) ?? reason);
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
	return changesReport(agentId, result) + outputsReport(agentId, result.outputs);
}

function changesReport(agentId: string, result: WorktreeResult): string {
	if (!result.ref) return `\n\nIsolated run ${agentId} changed no ${result.outputs ? "tracked " : ""}files.`;
	if (result.conflict)
		return `\n\nIsolated changes are saved on ${result.ref}, built on a snapshot of the parent's uncommitted files; they conflict with the commit the run started from in ${conflictFiles(result.conflict.reason)}. The child's own change (patch ${result.conflict.patch}):\n${result.stat}\nMerge with \`agent\` type \`coordinate\`, action \`merge\`, subagent \`${result.ref.slice(REF_PREFIX.length)}\`; it lists the conflicting files and leaves the ref. Or apply the patch by hand (\`git apply --3way\`).`;
	return `\n\nIsolated changes are on ${result.ref}, not in this tree:\n${result.stat}\nMerge with \`agent\` type \`coordinate\`, action \`merge\`, subagent \`${result.ref.slice(REF_PREFIX.length)}\` (the user: \`/agents merge ${result.ref.slice(REF_PREFIX.length)}\`), not \`git merge\`: it checks reservations, removes the ref and notes the merge on the item.`;
}
