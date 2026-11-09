import { gitQuiet } from "../../utils/git-run.ts";
import { heldChanges, mergeRef } from "../worktrees/merge.ts";
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
	const merged = await mergeRef(repo, ref);
	if (!merged.ok) return merged;
	await gitQuiet(repo, ["update-ref", "-d", ref]);
	return { ok: true, ref, into: merged.into, text: `Merged ${ref} into ${merged.into}.` };
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

/** Agent ids of isolated results not merged yet, under the current ref path or the legacy one. */
export async function pendingRefs(cwd: string): Promise<string[]> {
	const out = (await gitQuiet(cwd, ["for-each-ref", "--format=%(refname)", REF_PREFIX])) ?? "";
	const id = (ref: string) => ref.slice((ref.startsWith(LEGACY_REF_PREFIX) ? LEGACY_REF_PREFIX : REF_PREFIX).length);
	return [...new Set(out.split("\n").filter(Boolean).map(id))];
}
