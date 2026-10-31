import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { git, gitQuiet, type GitOptions } from "../shared/git.ts";

/** Temporary Git indexes keep both snapshot and delta generation off the parent's branch and index. */
const IDENTITY = ["-c", "user.name=Octocode", "-c", "user.email=octocode@localhost"];

/** Git options that run a command against a private index file instead of the repository's own. */
const onIndex = (index: string): GitOptions => ({ env: { GIT_INDEX_FILE: index } });

async function withIndex<T>(work: (index: string, dir: string) => Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-worktree-index-"));
	fs.chmodSync(dir, 0o700);
	try {
		return await work(path.join(dir, "index"), dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** The paths of `git ls-files` with `flags` in `repo` (NUL separated, so any file name is safe). */
const listFiles = async (repo: string, flags: string[], config: string[] = []): Promise<string[]> =>
	(await git(repo, [...config, "ls-files", ...flags, "-z"])).split("\0").filter(Boolean);

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

/** Capture tracked and non-ignored untracked files as a private commit, without touching the parent's index. */
export function snapshotWorkingCopy(repo: string, base: string): Promise<string> {
	return withIndex(async (index) => {
		if ((await git(repo, ["rev-parse", "HEAD"])) !== base)
			throw new Error("HEAD changed before the working-copy snapshot; retry after the checkout settles.");
		await rejectCleanFilters(repo);
		await git(repo, ["read-tree", base], onIndex(index));
		await git(repo, ["add", "-A", "--", "."], onIndex(index));
		const tree = await git(repo, ["write-tree"], onIndex(index));
		await git(repo, ["add", "-A", "--", "."], onIndex(index));
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

/** Rebase only snapshot-to-worker changes onto HEAD; conflicts keep the worktree for manual recovery. */
export function workerDeltaCommit(
	repo: string,
	base: string,
	snapshot: string,
	head: string,
	agentId: string,
): Promise<string> {
	return withIndex(async (index, dir) => {
		await git(repo, ["read-tree", base], onIndex(index));
		const patch = await git(repo, ["diff", "--binary", "--no-ext-diff", snapshot, head], { raw: true });
		const patchFile = path.join(dir, "worker.patch");
		fs.writeFileSync(patchFile, patch, { mode: 0o600 });
		await git(repo, ["apply", "--cached", "--3way", patchFile], onIndex(index));
		const tree = await git(repo, ["write-tree"], onIndex(index));
		if (tree === (await git(repo, ["rev-parse", `${base}^{tree}`]))) return base;
		return git(
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
				throw new Error(`Could not save the subagent's changes under ${candidate}: ${errorMessage(error)}`);
		}
	}
	throw new Error(`Could not save the subagent's changes: ${ref} and its fallbacks are taken.`);
}
