import fs from "node:fs";
import { octocodeTmpDir, workspaceScratchDir } from "../shared/home.ts";
import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { EXCLUDE_WORKSPACE_STATE, git, gitQuiet, type GitOptions } from "../../utils/git-run.ts";

/** Temporary Git indexes keep both snapshot and delta generation off the parent's branch and index. */
const IDENTITY = ["-c", "user.name=Octocode", "-c", "user.email=octocode@localhost"];

/** Git options that run a command against a private index file instead of the repository's own. */
const onIndex = (index: string): GitOptions => ({ env: { GIT_INDEX_FILE: index } });

/** Diff output that `git apply` and a report can read whatever the user's Git configuration (color, prefixes) says. */
export const PLAIN_DIFF = ["--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"];

async function withIndex<T>(repo: string, work: (index: string, dir: string) => Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(path.join(workspaceScratchDir(repo, "indexes"), "index-"));
	fs.chmodSync(dir, 0o700);
	try {
		return await work(path.join(dir, "index"), dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** The paths of `git ls-files` with `flags` in `repo` (NUL separated, so any file name is safe). */
const listFiles = async (repo: string, flags: string[], config: string[] = []): Promise<string[]> =>
	(await git(repo, [...config, "ls-files", ...flags, "-z", "--", EXCLUDE_WORKSPACE_STATE])).split("\0").filter(Boolean);

/** The Git filter driver of each of `files` that has one: `git add` would run its configured clean/process command. */
async function filterDrivers(repo: string, files: string[]): Promise<Map<string, string>> {
	const drivers = new Map<string, string>();
	for (let offset = 0; offset < files.length; offset += 256) {
		const attributes = await git(repo, ["check-attr", "-z", "filter", "--", ...files.slice(offset, offset + 256)]);
		const fields = attributes.split("\0");
		for (let at = 0; at + 2 < fields.length; at += 3)
			if (fields[at + 2] !== "unspecified" && fields[at + 2] !== "unset") drivers.set(fields[at], fields[at + 2]);
	}
	return drivers;
}

/** A snapshot never runs configured clean/process filters implicitly. */
async function rejectCleanFilters(repo: string): Promise<void> {
	const [file] = await filterDrivers(repo, await listFiles(repo, ["--cached", "--others", "--exclude-standard"]));
	if (file) throw new Error(`Working-copy snapshot refuses Git filter on ${file[0]}; capture it separately.`);
}

/**
 * Saving a worktree compares and stages what the child changed, which runs the clean filter of a changed file (Git LFS,
 * for one) outside the child's sandbox. It refuses instead, before `git status` or `git add`, so the worktree is kept as
 * the child left it. Files without a filter attribute (the usual case) cost one attribute lookup. Otherwise the
 * modified and untracked files are listed with every filter in play emptied and not required (`-c filter.<name>.clean=`), so that
 * listing, which hashes a file whose size is unchanged, runs no configured command; a filtered file it names is refused.
 */
export async function rejectChangedFilters(worktree: string): Promise<void> {
	const drivers = await filterDrivers(
		worktree,
		await listFiles(worktree, ["--cached", "--others", "--exclude-standard"]),
	);
	if (drivers.size === 0) return;
	const off = [...new Set(drivers.values())].flatMap((name) => [
		...["clean", "smudge", "process"].flatMap((key) => ["-c", `filter.${name}.${key}=`]),
		"-c",
		`filter.${name}.required=false`,
	]);
	const changed = await listFiles(worktree, ["--modified", "--others", "--exclude-standard"], off);
	const file = changed.find((each) => drivers.has(each));
	if (file) throw new Error(`Saving refuses to run the Git filter on ${file}`);
}

/**
 * A repository the child made or moved inside its worktree (`git init`, a clone, an initialised submodule) is saved as a
 * gitlink: a commit id whose files live only under the worktree, which removal deletes. Refuses such a change so the
 * worktree is kept.
 */
export async function rejectNestedRepositories(repo: string, from: string, head: string): Promise<void> {
	const fields = (await git(repo, ["diff-tree", "-r", "--no-renames", "-z", from, head], { raw: true })).split("\0");
	const nested: string[] = [];
	for (let at = 0; at + 1 < fields.length; at += 2)
		if (fields[at].split(" ")[1] === "160000") nested.push(fields[at + 1]);
	if (nested.length)
		throw new Error(`Saving refuses nested repositories, whose commits only this worktree holds: ${nested.join(", ")}`);
}

/** Capture tracked and non-ignored untracked files as a private commit, without touching the parent's index. */
export function snapshotWorkingCopy(repo: string, base: string): Promise<string> {
	return withIndex(repo, async (index) => {
		if ((await git(repo, ["rev-parse", "HEAD"])) !== base)
			throw new Error("HEAD changed before the working-copy snapshot; retry after the checkout settles.");
		await rejectCleanFilters(repo);
		await git(repo, ["read-tree", base], onIndex(index));
		await git(repo, ["add", "-A", "--", EXCLUDE_WORKSPACE_STATE], onIndex(index));
		const tree = await git(repo, ["write-tree"], onIndex(index));
		await git(repo, ["add", "-A", "--", EXCLUDE_WORKSPACE_STATE], onIndex(index));
		if ((await git(repo, ["write-tree"], onIndex(index))) !== tree || (await git(repo, ["rev-parse", "HEAD"])) !== base)
			throw new Error("Working copy or HEAD changed while snapshotting; retry when edits settle.");
		return git(repo, [
			...IDENTITY,
			"-c",
			"commit.gpgsign=false",
			"commit-tree",
			tree,
			"-p",
			base,
			"-m",
			"octocode working-copy snapshot",
		]);
	});
}

/** A lost owner record is recoverable for HEAD-only worktrees, never for a snapshot containing parent edits. */
export async function recoverWorktreeBase(repo: string, head: string): Promise<string> {
	const main = await gitQuiet(repo, ["rev-parse", "HEAD"]);
	const base = main && (await gitQuiet(repo, ["merge-base", head, main]));
	if (!base) throw new Error("its owner record is unreadable and its start commit could not be found");
	const subjects = await git(repo, ["log", "--first-parent", "--format=%s", `${base}..${head}`]);
	if (subjects.split("\n").includes("octocode working-copy snapshot"))
		throw new Error("its working-copy snapshot record is unreadable; refusing to export the parent's baseline");
	return base;
}

/** Owner metadata must identify the original commit and the snapshot directly parented to it. */
export async function validateSnapshot(
	repo: string,
	base: string,
	snapshot: string | undefined,
	head: string,
): Promise<void> {
	const oid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
	if (!oid.test(base) || (snapshot !== undefined && !oid.test(snapshot)))
		throw new Error("Invalid worktree owner commit metadata");
	if (snapshot && (await git(repo, ["rev-parse", `${snapshot}^`])) !== base)
		throw new Error("Working-copy snapshot is not based on its recorded HEAD");
	const ancestor = snapshot ?? base;
	try {
		await git(repo, ["merge-base", "--is-ancestor", ancestor, head]);
	} catch {
		throw new Error(`Worktree HEAD no longer descends from its recorded ${snapshot ? "snapshot" : "base"}`);
	}
}

/** What to save for a child that started from a working-copy snapshot. */
export interface WorkerDelta {
	/** The commit to put on the agent's ref: the child's changes on `base`, or on a conflict its own head, built on the snapshot. */
	commit: string;
	/** Set on a conflict: where the child's own patch (snapshot to head) was written, and why it did not apply to `base`. */
	conflict?: { patch: string; reason: string };
}

/** Writes the child's patch where the user can read and apply it by hand; the agent id names it, so a rerun replaces its own earlier one. */
function keepPatch(repo: string, agentId: string, patchFile: string): string {
	const dir = path.join(octocodeTmpDir(repo), "isolate");
	fs.mkdirSync(dir, { recursive: true });
	const kept = path.join(dir, `${agentId}.patch`);
	fs.copyFileSync(patchFile, kept);
	return kept;
}

/**
 * Moves only the snapshot-to-worker changes onto `base`. The patch applies to `base`, which lacks the parent's uncommitted
 * edits, so a child that changed lines the parent had edited conflicts however still the main tree is. Its work is then
 * kept as its own head commit (built on the snapshot, so the diff against `base` includes the parent's edits) and its
 * patch is written to `.octocode/tmp/isolate/<agent>.patch`, so nothing is lost and the user resolves the conflict.
 */
export function workerDeltaCommit(
	repo: string,
	base: string,
	snapshot: string,
	head: string,
	agentId: string,
): Promise<WorkerDelta> {
	return withIndex(repo, async (index, dir) => {
		await git(repo, ["read-tree", base], onIndex(index));
		// Git writes the patch itself: no output buffer caps the size of the child's change.
		const patchFile = path.join(dir, "worker.patch");
		await git(repo, [
			"diff",
			...PLAIN_DIFF,
			"--binary",
			`--output=${patchFile}`,
			snapshot,
			head,
			"--",
			EXCLUDE_WORKSPACE_STATE,
		]);
		try {
			await git(repo, ["apply", "--cached", "--3way", "--whitespace=nowarn", patchFile], onIndex(index));
		} catch (error) {
			return { commit: head, conflict: { patch: keepPatch(repo, agentId, patchFile), reason: errorMessage(error) } };
		}
		const tree = await git(repo, ["write-tree"], onIndex(index));
		if (tree === (await git(repo, ["rev-parse", `${base}^{tree}`]))) return { commit: base };
		const commit = await git(
			repo,
			[
				...IDENTITY,
				"-c",
				"commit.gpgsign=false",
				"commit-tree",
				tree,
				"-p",
				base,
				"-m",
				`octocode subagent ${agentId}`,
			],
			onIndex(index),
		);
		return { commit };
	});
}

/** Claim the first unused ref without overwriting an earlier isolated result. */
export async function saveWorkerRef(repo: string, ref: string, head: string): Promise<string> {
	for (let n = 1; n <= 100; n++) {
		const candidate = n === 1 ? ref : `${ref}-${n}`;
		try {
			await git(repo, ["update-ref", candidate, head, ""]);
			return candidate;
		} catch (error) {
			const existing = await gitQuiet(repo, ["rev-parse", "--verify", "--quiet", candidate]);
			if (existing === undefined)
				throw new Error(`Could not save the subagent's changes under ${candidate}: ${errorMessage(error)}`, {
					cause: error,
				});
		}
	}
	throw new Error(`Could not save the subagent's changes: ${ref} and its fallbacks are taken.`);
}
