import { realpathSync } from "node:fs";
import path from "node:path";
import { git, GitError, gitQuiet } from "../../utils/git-run.ts";
import { AGENT_FOLDERS } from "../../storage/agent-layout.ts";
import { workspaceAgentDir } from "../shared/home.ts";
import { worktreeBranch } from "./name.ts";

/** One entry of `git worktree list --porcelain -z`. */
export interface WorktreeEntry {
	/** Absolute path as git reports it. */
	path: string;
	head?: string;
	/** Short branch name; undefined when detached or bare. */
	branch?: string;
	bare: boolean;
	/** The folder is gone and `git worktree prune` would drop the entry. */
	prunable: boolean;
}

export const canonical = (file: string): string => {
	try {
		return realpathSync.native(file);
	} catch {
		return path.resolve(file);
	}
};

/**
 * Entries of `git worktree list --porcelain`: with `-z` (`nul`), fields end in NUL and a record in an empty field, so a
 * path holding a newline stays whole; without it, lines and blank lines.
 */
function parseWorktreeList(output: string, nul: boolean): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	for (const block of output.split(nul ? "\0\0" : /\r?\n\r?\n/u)) {
		const entry: WorktreeEntry = { path: "", bare: false, prunable: false };
		for (const line of block.split(nul ? "\0" : /\r?\n/u)) {
			const space = line.indexOf(" ");
			const key = space === -1 ? line : line.slice(0, space);
			const value = space === -1 ? "" : line.slice(space + 1);
			if (key === "worktree") entry.path = value;
			else if (key === "HEAD") entry.head = value;
			else if (key === "branch") entry.branch = value.replace(/^refs\/heads\//u, "");
			else if (key === "bare") entry.bare = true;
			else if (key === "prunable") entry.prunable = true;
		}
		if (entry.path) entries.push(entry);
	}
	return entries;
}

/** Every worktree of the repository `cwd` belongs to, the main one first. Rejects when `cwd` is not in a repository. */
async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
	let entries: WorktreeEntry[];
	try {
		entries = parseWorktreeList(await git(cwd, ["worktree", "list", "--porcelain", "-z"], { raw: true }), true);
	} catch (error) {
		// Git before 2.36 has no `-z` here and exits 129 for the unknown switch.
		if (!(error instanceof GitError) || error.exitCode !== 129) throw error;
		entries = parseWorktreeList(await git(cwd, ["worktree", "list", "--porcelain"]), false);
	}
	if (entries.length === 0) throw new Error("git reported no worktrees.");
	return entries;
}

export interface WorktreeRepo {
	/** Top level of the checkout `cwd` is in: the source of `.worktreeinclude` and of the new branch's start point. */
	checkout: string;
	/** The main worktree's root, where `.octocode/agent/worktrees` lives, whichever worktree `cwd` is in. */
	main: string;
	entries: WorktreeEntry[];
}

/** Where `cwd` sits in its repository, with the clear errors a user needs outside one or in an empty one. */
export async function locateRepo(cwd: string): Promise<WorktreeRepo> {
	const checkout = await gitQuiet(cwd, ["rev-parse", "--show-toplevel"]);
	if (!checkout)
		throw new Error(`${cwd} is not inside a git repository (or is a bare one): worktrees need a checkout.`);
	const entries = await listWorktrees(cwd);
	const [first] = entries;
	if (!first || first.bare) throw new Error("This repository is bare; worktrees need a repository with a checkout.");
	return { checkout: canonical(checkout), main: canonical(first.path), entries };
}

/** `<main root>/.octocode/agent/worktrees`. */
export const worktreesFolder = (main: string): string => path.join(workspaceAgentDir(main), AGENT_FOLDERS.worktrees);
export const worktreePath = (main: string, name: string): string => path.join(worktreesFolder(main), name);

/** The entry whose folder is `target`. */
export const entryAt = (entries: readonly WorktreeEntry[], target: string): WorktreeEntry | undefined =>
	entries.find((entry) => canonical(entry.path) === canonical(target));

export async function branchExists(cwd: string, name: string): Promise<boolean> {
	return (await gitQuiet(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${worktreeBranch(name)}`])) !== undefined;
}
