import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "@octocodeai/octocode-common/atomic-file";
import { repoKey } from "../../utils/git-repository.ts";
import { processStartTime, processStartTimeAsync } from "../shared/process.ts";

/** What isolated subagent worktrees share across the modules that create, save, merge and prune them (`worktree.ts` re-exports the public parts). */

/** Where an isolated agent's changes are saved; the agent id follows. */
export const REF_PREFIX = "refs/octocode/";
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
	/** What the dependency link left out, or a failure to link; absent when every `node_modules` folder is linked. */
	unlinked?: string;
}

/** The git-ignored files a child wrote under `.octocode/`, copied to the checkout before its worktree was removed; paths are relative to the checkout. */
export interface WorktreeOutputs {
	copied: string[];
	/** Paths where the checkout held a newer file, so the child's version was saved beside it. */
	conflicts: string[];
	/** Ignored paths outside `.octocode/agent/` (an ignored folder as one entry) that were not copied and vanish with the worktree; absent when none. */
	dropped?: string[];
}

export interface WorktreeResult {
	/** The private ref holding the subagent's changes; absent when it changed nothing. */
	ref?: string;
	/** `git diff --stat` of those changes. */
	stat?: string;
	/** Set when the child's changes did not apply to the commit it started from: the ref is the child's own head, built on the parent's working-copy snapshot; `patch` is its own change as a file. */
	conflict?: { patch: string; reason: string };
	/** Set when ignored output files were copied or held back (`worktree-outputs.ts`). */
	outputs?: WorktreeOutputs;
}

export { worktreesDir } from "../worktree-paths/own-worktree.ts";

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

/**
 * Adds the subagent's own process to the owner record, so a parent crash does not let a prune remove the worktree under
 * a live child. Its start time comes from one asynchronous `ps`, so a spawn never waits for it. Never rejects.
 */
export async function recordWorktreePid(worktree: Pick<Worktree, "path">, pid: number): Promise<void> {
	const meta = `${worktree.path}.json`;
	const started = await processStartTimeAsync(pid);
	const entry: Owner = started ? { pid, started } : { pid };
	try {
		const record = JSON.parse(fs.readFileSync(meta, "utf8")) as Record<string, unknown>;
		atomicWriteFileSync(
			meta,
			JSON.stringify({ ...record, owners: [...ownersOf(record).filter((each) => each.pid !== pid), entry] }),
		);
	} catch {
		// The record is gone: the worktree was already finished.
	}
}
