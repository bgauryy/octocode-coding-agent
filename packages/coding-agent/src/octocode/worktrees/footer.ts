import path from "node:path";
import type { Member } from "@octocodeai/octocode-contracts/team";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/index.ts";
import { gitQuiet } from "../shared/git.ts";
import { repoKey } from "../shared/home/repo.ts";
import { canonical } from "./repo.ts";

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

/** The folder name when `cwd` is in a linked worktree (git dir differs from the common dir), else undefined; one git call. */
async function linkedName(cwd: string, root: string): Promise<string | undefined> {
	const out = await gitQuiet(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
	const [gitDir, common] = out?.split(/\r?\n/u) ?? [];
	return gitDir && common && canonical(gitDir) !== canonical(common) ? path.basename(root) : undefined;
}

/**
 * Shows where this session works and who else is in the repository's other worktrees (`ctx.ui.setStatus`). One git call
 * at session start finds out whether this is a linked worktree; after that the text follows the team's own refresh tick
 * (`team.watch`, a cached read) and is written only when it changes.
 */
export function registerWorktreeFooter(api: ExtensionAPI, team: Pick<WorktreeTeam, "watch" | "view">): void {
	let stop: (() => void) | undefined;
	let generation = 0;
	const end = () => {
		generation++;
		stop?.();
		stop = undefined;
	};
	api.on("session_shutdown", async () => end());
	api.on("session_start", async (_event, ctx: ExtensionContext) => {
		end();
		const mine = generation;
		// A member's checkout is its repository root; a main session (the only one with a footer) has no workspace override.
		const root = repoKey(ctx.cwd).root;
		const linked = await linkedName(ctx.cwd, root);
		if (mine !== generation) return;
		let shown: string | undefined;
		stop = team.watch(() => {
			const text = worktreeFooterText(linked, root, team.view.members);
			if (text === shown) return;
			shown = text;
			ctx.ui.setStatus(WORKTREE_STATUS, text);
		});
	});
}
