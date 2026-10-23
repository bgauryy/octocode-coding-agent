import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { errorMessage } from "../shared/util.ts";

/** Temporary Git indexes keep both snapshot and delta generation off the parent's branch and index. */
const execFileAsync = promisify(execFile);
const IDENTITY = ["-c", "user.name=Octocode", "-c", "user.email=octocode@localhost"];

async function git(cwd: string, args: string[], index?: string, raw = false): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			maxBuffer: 16 * 1024 * 1024,
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(index ? { GIT_INDEX_FILE: index } : {}) },
		});
		return raw ? stdout : stdout.trimEnd();
	} catch (error) {
		throw new Error((error as { stderr?: string }).stderr?.trim() || errorMessage(error));
	}
}

async function withIndex<T>(work: (index: string, dir: string) => Promise<T>): Promise<T> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-worktree-index-"));
	fs.chmodSync(dir, 0o700);
	try {
		return await work(path.join(dir, "index"), dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Git add may execute configured clean/process filters. A snapshot never runs those commands implicitly. */
async function rejectCleanFilters(repo: string): Promise<void> {
	const files = (await git(repo, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]))
		.split("\0")
		.filter(Boolean);
	for (let offset = 0; offset < files.length; offset += 256) {
		const attributes = await git(repo, ["check-attr", "-z", "filter", "--", ...files.slice(offset, offset + 256)]);
		const fields = attributes.split("\0");
		for (let at = 0; at + 2 < fields.length; at += 3)
			if (fields[at + 2] !== "unspecified" && fields[at + 2] !== "unset")
				throw new Error(`Working-copy snapshot refuses Git filter on ${fields[at]}; capture it separately.`);
	}
}

/** Capture tracked and non-ignored untracked files as a private commit, without touching the parent's index. */
export function snapshotWorkingCopy(repo: string, base: string): Promise<string> {
	return withIndex(async (index) => {
		if ((await git(repo, ["rev-parse", "HEAD"])) !== base)
			throw new Error("HEAD changed before the working-copy snapshot; retry after the checkout settles.");
		await rejectCleanFilters(repo);
		await git(repo, ["read-tree", base], index);
		await git(repo, ["add", "-A", "--", "."], index);
		const tree = await git(repo, ["write-tree"], index);
		await git(repo, ["add", "-A", "--", "."], index);
		if ((await git(repo, ["write-tree"], index)) !== tree || (await git(repo, ["rev-parse", "HEAD"])) !== base)
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
	const main = await git(repo, ["rev-parse", "HEAD"]).catch(() => undefined);
	const base = main && (await git(repo, ["merge-base", head, main]).catch(() => undefined));
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
		await git(repo, ["read-tree", base], index);
		const patch = await git(repo, ["diff", "--binary", "--no-ext-diff", snapshot, head], undefined, true);
		const patchFile = path.join(dir, "worker.patch");
		fs.writeFileSync(patchFile, patch, { mode: 0o600 });
		await git(repo, ["apply", "--cached", "--3way", patchFile], index);
		const tree = await git(repo, ["write-tree"], index);
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
			index,
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
			const existing = await git(repo, ["rev-parse", "--verify", "--quiet", candidate]).catch(() => undefined);
			if (existing === undefined)
				throw new Error(`Could not save the subagent's changes under ${candidate}: ${errorMessage(error)}`);
		}
	}
	throw new Error(`Could not save the subagent's changes: ${ref} and its fallbacks are taken.`);
}
