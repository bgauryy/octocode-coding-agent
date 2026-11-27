import { repoKey } from "../../utils/git-repository.ts";
import { foreignCliInCheckout } from "./foreign-clis.ts";

/** The part of the team this needs: its live members and this session's own id. */
interface SharingTeam {
	id?: string | undefined;
	members(): ReadonlyArray<{ id: string; role?: string; worktree?: unknown }>;
}

/**
 * Who else works in the checkout at `cwd`, for the gate that asks before a command discards uncommitted changes: true
 * when another Octocode main session of the team shares it, a description (`a Codex session (pid 7)`) when another
 * vendor's agent CLI runs in it, else undefined. Foreign CLIs are found by a process scan, shared for a few seconds.
 */
export function checkoutSharers(
	team: SharingTeam,
	lookup: (checkout: string) => ReturnType<ReturnType<typeof foreignCliInCheckout>> = foreignCliInCheckout(),
): (cwd: string) => Promise<true | string | undefined> {
	return async (cwd) => {
		if (team.members().some((member) => member.role === "main" && member.id !== team.id && !member.worktree))
			return true;
		const cli = await lookup(repoKey(cwd).root);
		return cli ? `a ${cli.name} session (pid ${cli.pid})` : undefined;
	};
}
