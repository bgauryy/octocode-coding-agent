import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, shortHash } from "../../../../common/src/atomic-file.ts";
import { HOME_NAMES } from "../shared/home.ts";
import { getOctocodeHome } from "../../config.ts";
import { repoKey } from "../../utils/git-repository.ts";
import { processStartTime } from "../shared/process.ts";

/** What isolated subagent worktrees share across the modules that create, save, merge and prune them (`worktree.ts` re-exports the public parts). */

/** Where an isolated agent's changes are saved; the agent id follows. */
export const REF_PREFIX = "refs/octocode/";
/** Where an earlier version saved results; they are still listed and merged, never written. */
export const LEGACY_REF_PREFIX = "refs/octocode/pi/";
export const ID_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export interface Worktree {
	agentId: string;
	/** The checkout the worktree was started from (its git top level; a linked worktree is its own checkout). */
	repo: string;
	/** The worktree directory. */
	path: string;
	/** The commit the worktree started from. */
	base: string;
	/** A private commit capturing the parent's working files when explicitly requested. */
	snapshot?: string;
	/** Where the subagent runs: the worktree, at the same subdirectory as the parent's cwd. */
	cwd: string;
	/** Set when the main tree had uncommitted changes, which the worktree does not see. */
	warning?: string;
}

export interface WorktreeResult {
	/** The private ref holding the subagent's changes; absent when it changed nothing. */
	ref?: string;
	/** `git diff --stat` of those changes. */
	stat?: string;
	/** Set when the child's changes did not apply to the commit it started from: the ref is the child's own head, built on the parent's working-copy snapshot; `patch` is its own change as a file. */
	conflict?: { patch: string; reason: string };
}

export { worktreesDir } from "../worktree-paths/own-worktree.ts";

/** The folder earlier versions used: named by the checkout's own root, so a linked worktree's orphans were not shared. */
export function legacyWorktreesDir(root: string, home = getOctocodeHome()): string {
	return path.join(home, HOME_NAMES.worktrees, shortHash(root));
}

/** The repository's checkout root, the same `repoKey` root the team workspace uses, so both always agree. */
export function repoRoot(cwd: string): string {
	const { root } = repoKey(cwd);
	if (!fs.existsSync(path.join(root, ".git")))
		throw new Error("isolate needs a git repository; run without isolate here.");
	return root;
}

/** A process that keeps a worktree: its pid and start time, so a later process that reused the pid does not keep it forever. */
export interface Owner {
	pid: number;
	started?: string;
}

export const owner = (pid: number): Owner => {
	const started = processStartTime(pid);
	return started ? { pid, started } : { pid };
};

/** The owners in a record; an owner without a start time (unknown where it ran) is judged by the pid alone. */
export function ownersOf(record: { owners?: unknown }): Owner[] {
	const listed = Array.isArray(record.owners) ? record.owners : [];
	return listed.flatMap((each: unknown) => {
		if (typeof each !== "object" || each === null) return [];
		const { pid, started } = each as { pid?: unknown; started?: unknown };
		return typeof pid === "number" ? [typeof started === "string" ? { pid, started } : { pid }] : [];
	});
}

/** Adds the subagent's own process to the owner record, so a parent crash does not let a prune remove the worktree under a live child. */
export function recordWorktreePid(worktree: Pick<Worktree, "path">, pid: number): void {
	const meta = `${worktree.path}.json`;
	try {
		const record = JSON.parse(fs.readFileSync(meta, "utf8")) as Record<string, unknown>;
		atomicWriteFileSync(
			meta,
			JSON.stringify({ ...record, owners: [...ownersOf(record).filter((each) => each.pid !== pid), owner(pid)] }),
		);
	} catch {
		// The record is gone: the worktree was already finished.
	}
}
