import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { gitQuiet } from "../../utils/git-run.ts";
import { heldChanges, mergeRef } from "../worktrees/merge.ts";
import { ID_PATTERN, REF_PREFIX, repoRoot } from "./worktree-base.ts";

/** The agent's saved ref, or undefined when none exists. */
async function savedRef(repo: string, agentId: string): Promise<string | undefined> {
	const ref = `${REF_PREFIX}${agentId}`;
	return (await gitQuiet(repo, ["rev-parse", "--verify", "--quiet", ref])) ? ref : undefined;
}

/**
 * Merges an isolated subagent's ref into the main tree with hooks disabled; on conflict aborts and lists the paths.
 * On success `ref` names the merged ref and `into` the branch, for whoever records the merge.
 */
export async function mergeAgent(
	cwd: string,
	agentId: string,
	signal?: AbortSignal,
): Promise<{ ok: boolean; text: string; ref?: string; into?: string }> {
	if (!ID_PATTERN.test(agentId)) return { ok: false, text: `Invalid agent id "${agentId}"` };
	const repo = repoRoot(cwd);
	const ref = await savedRef(repo, agentId);
	if (!ref) return { ok: false, text: `No isolated changes for ${agentId} (${REF_PREFIX}${agentId} does not exist).` };
	const merged = await mergeRef(repo, ref, signal);
	if (!merged.ok) return merged;
	await gitQuiet(repo, ["update-ref", "-d", ref]);
	return { ok: true, ref, into: merged.into, text: `Merged ${ref} into ${merged.into}.` };
}

/** The saved ref of `agentId` and the files it changes since its merge base with HEAD; undefined when none is saved. */
export async function savedChanges(
	cwd: string,
	agentId: string,
): Promise<{ ref: string; files: string[] } | undefined> {
	if (!ID_PATTERN.test(agentId)) return undefined;
	const repo = repoRoot(cwd);
	const ref = await savedRef(repo, agentId);
	if (!ref) return undefined;
	const changed = (await gitQuiet(repo, ["diff", "--name-only", "--no-renames", `HEAD...${ref}`])) ?? "";
	return { ref, files: changed.split("\n").filter(Boolean) };
}

/** Reverse-applies `patch` with `--check`: whether the working tree of `repo` already holds every change it makes. */
function reverseApplies(repo: string, patch: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", ["-C", repo, "apply", "--reverse", "--check", "-"], {
			stdio: ["pipe", "ignore", "ignore"],
		});
		child.once("error", reject);
		child.once("close", (code) => resolve(code === 0));
		child.stdin.end(patch);
	});
}

/**
 * Whether every change of `agentId`'s saved ref since its merge base with HEAD is already in the working tree (applied
 * by hand while the tree had other edits): that diff reverse-applies cleanly. False when nothing is saved or it changes nothing.
 */
export async function changesInTree(cwd: string, agentId: string): Promise<boolean> {
	if (!ID_PATTERN.test(agentId)) return false;
	const repo = repoRoot(cwd);
	const ref = await savedRef(repo, agentId);
	if (!ref) return false;
	const { stdout } = await promisify(execFile)("git", ["-C", repo, "diff", "--binary", `HEAD...${ref}`], {
		maxBuffer: 256 * 1024 * 1024,
	});
	return stdout.length > 0 && reverseApplies(repo, stdout);
}

/** Deletes the saved ref of `agentId` without merging it; the ref it deleted, or why there was none. */
export async function discardAgent(cwd: string, agentId: string): Promise<{ ok: boolean; text: string }> {
	if (!ID_PATTERN.test(agentId)) return { ok: false, text: `Invalid agent id "${agentId}"` };
	const repo = repoRoot(cwd);
	const ref = await savedRef(repo, agentId);
	if (!ref) return { ok: false, text: `No isolated changes for ${agentId} (${REF_PREFIX}${agentId} does not exist).` };
	if ((await gitQuiet(repo, ["update-ref", "-d", ref])) === undefined)
		return { ok: false, text: `Could not delete ${ref}; it is kept.` };
	return { ok: true, text: `Discarded ${ref}: its changes were not merged.` };
}

/**
 * Why the merge of `agentId`'s saved ref may not write its files: `reservation`'s refusal (another agent's lease, as
 * the file tool checks it) for each path the ref changes since its merge base with HEAD. Empty when nothing is held.
 */
export async function reservedChanges(
	cwd: string,
	agentId: string,
	reservation: (absolute: string, display: string) => string | undefined,
): Promise<string[]> {
	if (!ID_PATTERN.test(agentId)) return [];
	const repo = repoRoot(cwd);
	const ref = await savedRef(repo, agentId);
	return ref ? heldChanges(repo, ref, reservation) : [];
}

/** Agent ids of isolated results not merged yet. */
export async function pendingRefs(cwd: string): Promise<string[]> {
	const out = (await gitQuiet(cwd, ["for-each-ref", "--format=%(refname)", REF_PREFIX])) ?? "";
	return [
		...new Set(
			out
				.split("\n")
				.filter(Boolean)
				.map((ref) => ref.slice(REF_PREFIX.length)),
		),
	];
}
