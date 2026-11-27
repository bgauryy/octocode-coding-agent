import fs from "node:fs";
import path from "node:path";
import { worktreesDir } from "../worktree-paths/own-worktree.ts";
import { worktreesFolder } from "./repo.ts";
import { grantFolder } from "../trust/grants.ts";
import { shown } from "../trust/messages.ts";
import { resolveFolderTrust } from "../trust/resolve.ts";

/**
 * Trust for a worktree that is about to be created. The folder does not exist yet, so the user is asked before
 * `git worktree add` and a "No" leaves nothing behind. Yes records a `worktree` grant once the folder exists. A worktree
 * under a folder the user already trusted as a subtree needs no question. Nor does one Octocode keeps for the repository
 * when the checkout it comes from is trusted, since it holds that checkout's contents: an isolated subagent's under the
 * Octocode home (always: a question per spawn would stop an unattended run on its first isolated child), and
 * `/worktree new`'s under the main checkout's `.octocode/agent/worktrees` when a person asked for it in a session (the
 * question would repeat what they answered for the checkout). A headless run still needs `--trust` to record a grant.
 * Nothing here reads a project file.
 */

export interface WorktreeTrustRequest {
	/** Where the worktree will be created. */
	path: string;
	/** The checkout it is made from. */
	from: string;
	/** False when the checkout is not trusted: trusting the worktree then trusts that repository's contents. */
	originTrusted?: boolean;
}

/** Asks the user; absent where nobody can be asked (print, JSON, RPC, a subagent). */
export type WorktreeTrustAsk = (request: WorktreeTrustRequest) => Promise<boolean>;

/** The text of the question, for every surface that shows it. */
export const worktreeTrustTitle = (request: WorktreeTrustRequest): string =>
	`Trust new worktree ${shown(request.path)} (from ${shown(request.from)})?${
		request.originTrusted === false
			? ` ${shown(request.from)} is not trusted either: this trusts its contents under a new path.`
			: ""
	}`;

/** The user answered no to a worktree's trust question: nothing was created, and nothing went wrong. */
export class WorktreeDeclinedError extends Error {
	constructor(target: string) {
		super(`Worktree not created: ${shown(target)} was not trusted.`);
		this.name = "WorktreeDeclinedError";
	}
}

let flagGrants = false;

/** `--trust` was given: a headless run may record the grant for a worktree it creates. */
export function allowWorktreeGrants(allowed: boolean): void {
	flagGrants = allowed;
}

function nearestExisting(target: string): string {
	let folder = path.dirname(target);
	while (!fs.existsSync(folder) && path.dirname(folder) !== folder) folder = path.dirname(folder);
	return folder;
}

/** Whether a subtree grant already covers `target` (a folder that does not exist yet). */
function covered(target: string): boolean {
	const ancestor = nearestExisting(target);
	const trust = resolveFolderTrust(ancestor);
	if (trust.state !== "trusted") return false;
	return trust.grant.scope === "subtree" || trust.root !== trust.path;
}

/** Whether `request.path` is a direct child of `folder` (a worktrees folder Octocode keeps) and its checkout is trusted. */
function trustedCheckoutWorktree(request: WorktreeTrustRequest, folder: string): boolean {
	return (
		path.dirname(path.resolve(request.path)) === path.resolve(folder) &&
		resolveFolderTrust(request.from).state === "trusted"
	);
}

/**
 * Settles trust for the worktree at `request.path` before it is created. Throws when the user declines or nobody can
 * be asked. Returns the step that records the grant: call it after the worktree exists.
 */
export async function approveWorktree(
	request: WorktreeTrustRequest,
	surface: string,
	ask?: WorktreeTrustAsk,
): Promise<() => void> {
	if (covered(request.path)) return () => undefined;
	const record = () =>
		void grantFolder(request.path, "folder", { source: "worktree", surface, fromPath: request.from });
	// The worktree's session still reads its folder's trust when it starts, so the grant is recorded; only the question goes.
	if (trustedCheckoutWorktree(request, worktreesDir(request.from))) return record;
	if (ask) {
		if (trustedCheckoutWorktree(request, worktreesFolder(request.from))) return record;
		const originTrusted = resolveFolderTrust(request.from).state === "trusted";
		if (!(await ask({ ...request, originTrusted }))) throw new WorktreeDeclinedError(request.path);
		return record;
	}
	if (flagGrants) return record;
	throw new Error(
		`Creating a worktree needs your trust for ${shown(request.path)} (from ${shown(request.from)}). Run again with --trust to record it.`,
	);
}
