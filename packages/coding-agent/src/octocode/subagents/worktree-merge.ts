import path from "node:path";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { git, gitQuiet, NO_HOOKS, rejectTrackedWorkspaceState } from "../shared/git.ts";
import { ID_PATTERN, LEGACY_REF_PREFIX, REF_PREFIX, repoRoot } from "./worktree-base.ts";

/** The agent's saved ref under the current path, else the legacy one, else undefined. */
async function savedRef(repo: string, agentId: string): Promise<string | undefined> {
	const [ref, legacy] = [REF_PREFIX, LEGACY_REF_PREFIX].map((prefix) => `${prefix}${agentId}`);
	const exists = (candidate: string) => gitQuiet(repo, ["rev-parse", "--verify", "--quiet", candidate]);
	return (await exists(ref)) ? ref : (await exists(legacy)) ? legacy : undefined;
}

/**
 * Merges an isolated subagent's ref into the main tree with hooks disabled; on conflict aborts and lists the paths.
 * On success `ref` names the merged ref and `into` the branch, for whoever records the merge.
 */
export async function mergeAgent(
	cwd: string,
	agentId: string,
): Promise<{ ok: boolean; text: string; ref?: string; into?: string }> {
	if (!ID_PATTERN.test(agentId)) return { ok: false, text: `Invalid agent id "${agentId}"` };
	const repo = repoRoot(cwd);
	const ref = await savedRef(repo, agentId);
	if (!ref) return { ok: false, text: `No isolated changes for ${agentId} (${REF_PREFIX}${agentId} does not exist).` };
	if (await gitQuiet(repo, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])) {
		return {
			ok: false,
			text: `A merge is already in progress. Finish or abort it before merging ${ref}; your resolution and the agent ref are kept.`,
		};
	}
	try {
		await rejectTrackedWorkspaceState(repo, ref);
		await git(repo, [...NO_HOOKS, "merge", "--no-ff", "--no-edit", ref]);
	} catch (error) {
		const conflicts = (await gitQuiet(repo, ["diff", "--name-only", "--diff-filter=U"])) ?? "";
		if (await gitQuiet(repo, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])) {
			if ((await gitQuiet(repo, ["merge", "--abort"])) === undefined) {
				return {
					ok: false,
					text: `Merging ${ref} failed and could not be aborted. The merge is still in progress; inspect git status before continuing. ${ref} is kept.\n${errorMessage(error)}`,
				};
			}
		}
		if (conflicts)
			return {
				ok: false,
				text: `Merging ${ref} conflicts in:\n${conflicts}\nThe merge was aborted and the tree is unchanged; ${ref} is kept.`,
			};
		return { ok: false, text: `Merging ${ref} failed: ${errorMessage(error)}` };
	}
	await gitQuiet(repo, ["update-ref", "-d", ref]);
	const into = (await gitQuiet(repo, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "HEAD";
	return { ok: true, ref, into, text: `Merged ${ref} into ${into}.` };
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
	if (!ref) return [];
	const changed = (await gitQuiet(repo, ["diff", "--name-only", "--no-renames", `HEAD...${ref}`])) ?? "";
	return changed
		.split("\n")
		.filter(Boolean)
		.flatMap((file) => reservation(path.join(repo, file), file) ?? []);
}

/** Agent ids of isolated results not merged yet, under the current ref path or the legacy one. */
export async function pendingRefs(cwd: string): Promise<string[]> {
	const out = (await gitQuiet(cwd, ["for-each-ref", "--format=%(refname)", REF_PREFIX])) ?? "";
	const id = (ref: string) => ref.slice((ref.startsWith(LEGACY_REF_PREFIX) ? LEGACY_REF_PREFIX : REF_PREFIX).length);
	return [...new Set(out.split("\n").filter(Boolean).map(id))];
}
