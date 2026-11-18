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

const peerAsk = (what: string): string =>
	`\`${what}\` can discard uncommitted changes in this checkout, and another session works in it: it may lose that session's work.`;

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
	/** Whether another live session works in this checkout; the main session's gate exists only when this is given. */
	peers?: () => boolean;
}): ((event: ToolCallEvent, ctx: FeatureContext) => Promise<GateVerdict | undefined>) | undefined {
	if (!scope.subagent) {
		const { peers } = scope;
		if (!peers) return undefined;
		return async (event) => {
			if (!SHELL_TOOLS.has(event.toolName)) return undefined;
			const command = optionalString((event.input as Record<string, unknown>).command);
			const found = command === undefined ? undefined : gitStateMutation(command);
			return found && DISCARDS_WORK.test(found) && peers() ? { ask: peerAsk(found) } : undefined;
		};
	}
	if (scope.isolated) return undefined;
	return async (event) => {
		if (!SHELL_TOOLS.has(event.toolName)) return undefined;
		const command = optionalString((event.input as Record<string, unknown>).command);
		const found = command === undefined ? undefined : gitStateMutation(command);
		return found ? { block: true, reason: gitStateRefusal(found) } : undefined;
	};
}
