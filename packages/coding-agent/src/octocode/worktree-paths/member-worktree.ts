import fs from "node:fs";
import path from "node:path";
import { canonicalPath } from "@octocodeai/octocode-common/canonical-path";
import { repoKey } from "../../utils/git-repository.ts";
import type { Member } from "@octocodeai/octocode-contracts/team";

/**
 * The folder of the worktree `member` works in when it is not `root`, the viewer's checkout, else undefined (the main
 * checkout shows nothing). Its recorded checkout differs (a session in a linked worktree), or the folder it works in lies
 * outside `root`: an isolated child stays on its coordinator's team on purpose, so its checkout is the coordinator's
 * (reservations compare against the merge target) and only its `cwd` names its private worktree.
 */
export function memberWorktree(member: Pick<Member, "checkout" | "cwd">, root: string | undefined): string | undefined {
	if (!root) return undefined;
	if (member.checkout && member.checkout !== root) return member.checkout;
	if (!member.cwd) return undefined;
	const relative = path.relative(root, member.cwd);
	// Its folder may be a subfolder of the worktree (an isolated child starts at its coordinator's subfolder): name the root.
	return relative.startsWith("..") || path.isAbsolute(relative) ? worktreeRoot(member.cwd) : undefined;
}

/** The git root of `cwd`, spelled as `cwd` is (git resolves symlinks): `cwd` minus the segments below the root. */
function worktreeRoot(cwd: string): string {
	const below = path.relative(repoKey(cwd).root, canonicalPath(cwd));
	if (!below || below.startsWith("..") || path.isAbsolute(below)) return cwd;
	return path.resolve(cwd, ...below.split(path.sep).map(() => ".."));
}

/** The short name of a worktree folder: its last segment. */
export const worktreeName = (folder: string): string => path.basename(folder);

/** `worktree hotfix`, or `worktree hotfix (gone)` when the folder no longer exists (an isolated child's is removed at its end). */
export function worktreeLabel(folder: string): string {
	return `worktree ${worktreeName(folder)}${fs.existsSync(folder) ? "" : " (gone)"}`;
}
