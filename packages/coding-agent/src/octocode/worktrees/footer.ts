import type { Member } from "@octocodeai/octocode-contracts/team";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import { repoKey, workspaceGit } from "../../utils/git-repository.ts";

/** What the worktree command and footer need from the team, passed in so this domain does not depend on `team/`. */
export interface WorktreeTeam {
	members(): Member[];
	watch(listener: () => void): () => void;
	readonly view: { readonly members: readonly Member[] };
}

/** The footer key `ctx.ui.setStatus` is given. */
const WORKTREE_STATUS = "worktree";

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The footer text: `worktree <name>` in a linked worktree (`linked`, the folder name), and `+N agents in M worktrees` for the
 * team's live agents whose checkout is not `root`. Undefined when neither applies, as in a repository with no linked worktree.
 */
export function worktreeFooterText(
	linked: string | undefined,
	root: string,
	members: readonly Member[],
): string | undefined {
	const elsewhere = members.filter((member) => member.checkout !== undefined && member.checkout !== root);
	const parts = [
		linked ? `worktree ${linked}` : "",
		elsewhere.length > 0
			? `+${plural(elsewhere.length, "agent")} in ${plural(new Set(elsewhere.map((member) => member.checkout)).size, "worktree")}`
			: "",
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The footer reads the same checkout discovery as the workspace catalog, then updates when the team view changes.
 */
export function registerWorktreeFooter(api: ExtensionAPI, team: Pick<WorktreeTeam, "watch" | "view">): void {
	let stop: (() => void) | undefined;
	const end = () => {
		stop?.();
		stop = undefined;
	};
	api.on("session_shutdown", async () => end());
	api.on("session_start", async (_event, ctx: ExtensionContext) => {
		end();
		// A member's checkout is its repository root; a main session (the only one with a footer) has no workspace override.
		const { root, name } = repoKey(ctx.cwd);
		const linked = workspaceGit(ctx.cwd)?.linkedWorktree ? name : undefined;
		let shown: string | undefined;
		stop = team.watch(() => {
			const text = worktreeFooterText(linked, root, team.view.members);
			if (text === shown) return;
			shown = text;
			ctx.ui.setStatus(WORKTREE_STATUS, text);
		});
	});
}
