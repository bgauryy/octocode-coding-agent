import fs from "node:fs";
import path from "node:path";
import { globalPaths, workspacePaths } from "../home.ts";
import { parseJson } from "../util.ts";
import { readText, realPath } from "./files.ts";
import { isRecord } from "../../../utils/guards.ts";

interface StoredDecision {
	sha: string;
	trusted: boolean;
}

/** How long a save waits for another session's store lock, and when a lock is old enough to be a crashed holder's. */
const STORE_LOCK_WAIT_MS = 2_000;
const STORE_LOCK_STALE_MS = 10_000;

/**
 * Run `update` holding `<file>.lock` (created exclusively), so sessions that read, change and write the same file
 * never drop each other's change. A lock older than `STORE_LOCK_STALE_MS`, or still held after `STORE_LOCK_WAIT_MS`,
 * belongs to a crashed or stuck holder and is taken over.
 */
export function withFileLock(file: string, update: () => void): void {
	const lock = `${file}.lock`;
	const deadline = Date.now() + STORE_LOCK_WAIT_MS;
	for (;;) {
		try {
			fs.closeSync(fs.openSync(lock, "wx", 0o600));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const since = fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs;
			if (since !== undefined && Date.now() - since < STORE_LOCK_STALE_MS && Date.now() < deadline)
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
			else fs.rmSync(lock, { force: true });
		}
	}
	try {
		update();
	} finally {
		fs.rmSync(lock, { force: true });
	}
}

export const storePath = (home?: string) => globalPaths(process.env, home).trust;

/** One decision per repository: the gated files hang from its root, whichever subfolder Octocode starts in. */
export function storeKey(cwd: string): string {
	return realPath(workspacePaths(cwd).root);
}

/** `root` is a linked worktree of the repository at `parent`: its `.git` file points into `<parent>/.git/worktrees/`. */
export function isWorktreeOf(root: string, parent: string): boolean {
	const gitdir = /^gitdir:\s*(.+)$/m.exec(readText(path.join(root, ".git")))?.[1]?.trim();
	if (!gitdir) return false;
	const relative = path.relative(path.join(parent, ".git", "worktrees"), realPath(path.resolve(root, gitdir)));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Where earlier builds kept this store: the core `/trust` file, which keeps these entries for this migration. */
const legacyStorePath = (home?: string) => path.join(globalPaths(process.env, home).home, "trust.json");

export function readStore(home?: string): Record<string, StoredDecision> {
	// Until this store is first written, decisions saved by earlier builds (trusted or not) still apply.
	const file = fs.existsSync(storePath(home)) ? storePath(home) : legacyStorePath(home);
	const parsed = parseJson(readText(file));
	if (!isRecord(parsed)) return {};
	return Object.fromEntries(
		Object.entries(parsed).flatMap(([key, value]) =>
			isRecord(value) && typeof value.sha === "string" && typeof value.trusted === "boolean"
				? [[key, { sha: value.sha, trusted: value.trusted }]]
				: [],
		),
	);
}
