import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const git = promisify(execFile);
const run = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
	git("git", ["-C", cwd, ...args], { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });

const refName = (ref: string): string => `refs/octocode/qa-baseline/${ref}`;

/**
 * The working tree as a git tree object: every tracked and untracked, non-ignored file as it is now, whether staged or
 * not. It is built in a throwaway copy of the index, so the real index and working tree stay untouched. Undefined
 * outside a git checkout or when git fails: the caller then has no baseline, which it treats as "unknown".
 */
export async function snapshotTree(cwd: string): Promise<string | undefined> {
	let temp: string | undefined;
	try {
		const { stdout } = await run(cwd, ["rev-parse", "--git-path", "index"]);
		const index = path.resolve(cwd, stdout.trim());
		temp = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-qa-index-"));
		const copy = path.join(temp, "index");
		if (fs.existsSync(index)) fs.copyFileSync(index, copy);
		const env = { GIT_INDEX_FILE: copy };
		await run(cwd, ["add", "-A", "--", "."], env);
		return (await run(cwd, ["write-tree"], env)).stdout.trim() || undefined;
	} catch {
		return undefined;
	} finally {
		if (temp) fs.rmSync(temp, { recursive: true, force: true });
	}
}

/**
 * Records the working tree as item `ref`'s baseline when it has none yet (a re-claim after a send-back keeps the first
 * one, so the earlier work stays the item's). A ref keeps the tree from garbage collection. Never rejects.
 */
export async function recordBaseline(cwd: string, ref: string): Promise<void> {
	if ((await readBaseline(cwd, ref)) !== undefined) return;
	const tree = await snapshotTree(cwd);
	if (!tree) return;
	try {
		await run(cwd, ["update-ref", refName(ref), tree]);
	} catch {
		// No baseline is the documented fallback: the review then judges the reported files against HEAD.
	}
}

/** The tree recorded when item `ref` was claimed, or undefined when none was. */
export async function readBaseline(cwd: string, ref: string): Promise<string | undefined> {
	try {
		return (await run(cwd, ["rev-parse", "--verify", "--quiet", refName(ref)])).stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Drops item `ref`'s baseline once the item ends. Never rejects. */
export async function dropBaseline(cwd: string, ref: string): Promise<void> {
	try {
		await run(cwd, ["update-ref", "-d", refName(ref)]);
	} catch {
		// Nothing to drop.
	}
}
