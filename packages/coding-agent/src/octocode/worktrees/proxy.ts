import path from "node:path";
import { repoKey, workspaceGit } from "../../utils/git-repository.ts";
import type { WorktreeRepo } from "./repo.ts";
import { type OpeningScope, worktreeOpenings } from "./openings.ts";

/** The recorded opener a worktree session has when the user, not an agent, made its worktree. */
const USER_OPENER = "user";

/**
 * The agent that created the linked worktree at `checkout` (`/worktree new` records it), else undefined: the user made
 * it, or it predates the record. That agent is the orchestrator the worktree session is a proxy of.
 */
export function recordedCreator(checkout: string, scope: OpeningScope = {}): string | undefined {
	const opener = worktreeOpenings([checkout], scope).get(checkout)?.opener;
	return opener && opener !== USER_OPENER ? opener : undefined;
}

/** Who a linked worktree session answers to, in words: its recorded creator, else the session in the main checkout. */
function orchestratorLabel(checkout: string, main: string, scope: OpeningScope = {}): string {
	const creator = recordedCreator(checkout, scope);
	return creator ? `${creator} (the session that created it)` : `the main-checkout session of ${main}`;
}

/**
 * Throws when `repo`'s checkout is a linked worktree: that session is a proxy of the orchestrator in the main checkout and may
 * not create worktrees (`what`), whose count and merges the orchestrator owns. A main checkout passes.
 */
export function refuseFromLinkedWorktree(
	repo: Pick<WorktreeRepo, "checkout" | "main">,
	what: string,
	scope: OpeningScope = {},
): void {
	if (repo.checkout === repo.main) return;
	throw new Error(
		`Refused: ${what} from a linked worktree. ${repo.checkout} is a proxy of its orchestrator, ${orchestratorLabel(repo.checkout, repo.main, scope)}, which alone creates worktrees. ` +
			`Work in this tree, start non-isolated subagents here, and ask the orchestrator (\`agent\` message to "coordinator") for another worktree.`,
	);
}

/** The orchestrator a session in the linked worktree at `cwd` is a proxy of, in words; undefined in any other folder. Read without a git process. */
export function orchestratorOf(cwd: string, scope: OpeningScope = {}): string | undefined {
	const git = workspaceGit(cwd);
	if (!git?.linkedWorktree) return undefined;
	return orchestratorLabel(repoKey(cwd).root, path.dirname(git.commonDir), scope);
}

/**
 * `this session, a proxy of <orchestrator>` when `cwd` is in a linked worktree (for gates that run before every command),
 * else undefined.
 */
export function linkedSession(cwd: string): string | undefined {
	const orchestrator = orchestratorOf(cwd);
	return orchestrator && `this session, a proxy of ${orchestrator},`;
}
