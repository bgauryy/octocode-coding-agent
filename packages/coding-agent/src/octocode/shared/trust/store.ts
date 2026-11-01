import fs from "node:fs";
import path from "node:path";
import { withFileLockSync } from "../../../../../common/src/file-write-lock.ts";
import { globalPaths, workspacePaths } from "../home.ts";
import { parseJson } from "../util.ts";
import { readText, realPath } from "./files.ts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

interface StoredDecision {
	sha: string;
	trusted: boolean;
}

/** A save waits about two seconds (100 × 20ms) for another session's store lock, then reports it busy. */
const STORE_LOCK_ATTEMPTS = 100;
/** Earlier builds made the lock a regular file; one this old was left by a crashed holder. */
const LEGACY_LOCK_STALE_MS = 10_000;

/**
 * Run `update` holding `<file>.lock`, so sessions that read, change and write the same file never drop each other's
 * change. A live holder is never broken: a waiter fails with `ELOCKED`. Call `assertHeld` right before writing; it throws
 * when a stalled holder's lock was taken over (see `withFileLockSync`).
 */
export function withFileLock(file: string, update: (assertHeld: () => void) => void): void {
	const lock = `${file}.lock`;
	const legacy = fs.statSync(lock, { throwIfNoEntry: false });
	if (legacy?.isFile() && Date.now() - legacy.mtimeMs > LEGACY_LOCK_STALE_MS) {
		try {
			fs.unlinkSync(lock);
		} catch {
			// Another session cleared it (and may hold the lock directory now).
		}
	}
	withFileLockSync(file, update, { lockfilePath: lock, attempts: STORE_LOCK_ATTEMPTS });
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
