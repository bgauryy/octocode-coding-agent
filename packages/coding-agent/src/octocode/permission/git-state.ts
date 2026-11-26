import type { FeatureContext, ToolCallEvent } from "../../core/features/index.ts";
import { optionalString } from "../shared/util.ts";
import type { GateVerdict } from "./gate.ts";
import { SHELL_TOOLS } from "./shell.ts";
import { gitStateMutation } from "./shell/git-state.ts";

/** Why a subagent in the shared tree may not run `what` (`git add`, `git stash`…): its parent owns the git state. */
const gitStateRefusal = (what: string): string =>
	`Refused: \`${what}\` changes git state (the index, stashes, commits or checked-out files) that every agent in this working tree shares. ` +
	"Leave git state to your coordinator: do not stage, unstage, stash, commit, reset or restore; report the files you changed instead. " +
	"A subagent started with isolate: true works in its own worktree and may run it.";

/** The mutations that drop uncommitted changes in the tree, as `gitStateMutation` names them. */
const DISCARDS_WORK = /^git (?:stash|restore|checkout -- <path>)/;

/** `who` is what `peers` found: true for another Octocode session, else a description such as `a Codex session (pid 7)`. */
const peerAsk = (what: string, who: string | true): string =>
	`\`${what}\` can discard uncommitted changes in this checkout, and ${who === true ? "another session" : who} works in it: it may lose that session's work.`;

const WORKTREE_ADD = "git worktree add";

/** Why a session that is not its repository's main orchestrator may not run `git worktree add`. */
const worktreeRefusal = (who: string): string =>
	`Refused: \`${WORKTREE_ADD}\` creates a worktree, and ${who} may not: only the main orchestrator of this repository does. ` +
	"Work in this tree and report what you need to your coordinator.";

/**
 * The invariant gate that keeps a subagent working in the shared tree off git state: a shell call whose command stages,
 * unstages, stashes, commits, resets or restores (`shell/git-state.ts`) is refused, whatever the permission mode or a
 * hook says. An isolated subagent works in a private worktree and has no gate. The main session is asked, not refused,
 * before a command that stashes, restores or checks out paths while `peers` says another session shares the checkout;
 * `tool-gates.ts` tells them apart.
 */
export function gitStateGate(scope: {
	subagent: boolean;
	isolated: boolean;
	/**
	 * Whether another live session works in this checkout, given its folder: true for an Octocode session, a description
	 * for another vendor's CLI; the main session's gate exists only when this is given.
	 */
	peers?: (cwd: string) => boolean | string | undefined | Promise<boolean | string | undefined>;
	/** Describes this session, a proxy of its orchestrator, when the folder is a linked worktree; else undefined. */
	orchestrator?: (cwd: string) => string | undefined;
}): ((event: ToolCallEvent, ctx: FeatureContext) => Promise<GateVerdict | undefined>) | undefined {
	const { peers, orchestrator } = scope;
	if (!scope.subagent && !peers && !orchestrator) return undefined;
	return async (event, ctx) => {
		if (!SHELL_TOOLS.has(event.toolName)) return undefined;
		const command = optionalString((event.input as Record<string, unknown>).command);
		const found = command === undefined ? undefined : gitStateMutation(command);
		if (!found) return undefined;
		if (found === WORKTREE_ADD) {
			// A child, isolated or not, and a linked worktree's session are proxies: only the main orchestrator creates worktrees.
			const who = scope.subagent ? "a subagent" : orchestrator?.(ctx.cwd);
			return who ? { block: true, reason: worktreeRefusal(who) } : undefined;
		}
		if (scope.subagent) return scope.isolated ? undefined : { block: true, reason: gitStateRefusal(found) };
		if (!peers || !DISCARDS_WORK.test(found)) return undefined;
		const who = await peers(ctx.cwd);
		return who ? { ask: peerAsk(found, who) } : undefined;
	};
}
