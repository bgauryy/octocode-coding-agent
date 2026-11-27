import { plural } from "@octocodeai/octocode-common/clip";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import { memberWorktree } from "../worktree-paths/member-worktree.ts";
import { repoKey, workspaceGit } from "../../utils/git-repository.ts";

/** What the worktree command and footer need from the team, passed in so this domain does not depend on `team/`. */
export interface WorktreeTeam {
	members(): Member[];
	/** The session's own agent id; undefined before it joins the team. */
	readonly id: string | undefined;
	watch(listener: () => void): () => void;
	readonly view: { readonly members: readonly Member[] };
}

/** The footer key `ctx.ui.setStatus` is given. */
const WORKTREE_STATUS = "worktree";

/**
 * The footer text: `worktree <name>` in a linked worktree (`linked`, the folder name), and `+N agents in M worktrees` for the
 * team's live agents that work outside `root` (a linked worktree, or an isolated child's private one). Undefined when neither applies, as in a repository with no linked worktree.
 */
export function worktreeFooterText(
	linked: string | undefined,
	root: string,
	members: readonly Member[],
): string | undefined {
	const folders = members.flatMap((member) => memberWorktree(member, root) ?? []);
	const parts = [
		linked ? `worktree ${linked}` : "",
		folders.length > 0 ? `+${plural(folders.length, "agent")} in ${plural(new Set(folders).size, "worktree")}` : "",
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The footer reads the same checkout discovery as the workspace catalog, then updates when the team view changes.
 */
export function registerWorktreeFooter(api: FeatureSetup, team: Pick<WorktreeTeam, "watch" | "view">): void {
	let stop: (() => void) | undefined;
	const end = () => {
		stop?.();
		stop = undefined;
	};
	api.bus.on("session_shutdown", async () => end());
	api.bus.on("session_start", async (_event, ctx: FeatureContext) => {
		end();
		// Only a session with a terminal UI has a footer: a headless session, a subagent or an RPC worker has no `ui` to write.
		if (!ctx.hasUI) return;
		// A member's checkout is its repository root; a main session (the only one with a footer) has no workspace override.
		const { root, name } = repoKey(ctx.cwd);
		const linked = workspaceGit(ctx.cwd)?.linkedWorktree ? name : undefined;
		let shown: string | undefined;
		stop = team.watch(() => {
			const text = worktreeFooterText(linked, root, team.view.members);
			if (text === shown) return;
			shown = text;
			try {
				ctx.ui.setStatus(WORKTREE_STATUS, text);
			} catch {
				// The session was replaced or disposed without `session_shutdown` (its ctx is stale): this watcher has no
				// footer left to write, so it stops instead of throwing from the team's shared ticker on every tick.
				end();
			}
		});
	});
}
