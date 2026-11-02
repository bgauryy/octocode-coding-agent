import type { ExtensionContext, ToolCallEvent } from "../../core/features/index.ts";
import { optionalString } from "../shared/util.ts";
import type { GateVerdict } from "./gate.ts";
import { SHELL_TOOLS } from "./shell.ts";
import { gitStateMutation } from "./shell/git-state.ts";

/** Why a subagent in the shared tree may not run `what` (`git add`, `git stash`…): its parent owns the git state. */
const gitStateRefusal = (what: string): string =>
	`Refused: \`${what}\` changes git state (the index, stashes, commits or checked-out files) that every agent in this working tree shares. ` +
	"Leave git state to your parent: do not stage, unstage, stash, commit, reset or restore; report the files you changed instead. " +
	"A subagent started with isolate: true works in its own worktree and may run it.";

/**
 * The invariant gate that keeps a subagent working in the shared tree off git state: a shell call whose command stages,
 * unstages, stashes, commits, resets or restores (`shell/git-state.ts`) is refused, whatever the permission mode or a
 * hook says. Undefined (no gate) for the main session and for an isolated subagent, whose cwd is a private worktree;
 * `tool-gates.ts` tells them apart.
 */
export function gitStateGate(scope: {
	subagent: boolean;
	isolated: boolean;
}): ((event: ToolCallEvent, ctx: ExtensionContext) => Promise<GateVerdict | undefined>) | undefined {
	if (!scope.subagent || scope.isolated) return undefined;
	return async (event) => {
		if (!SHELL_TOOLS.has(event.toolName)) return undefined;
		const command = optionalString((event.input as Record<string, unknown>).command);
		const found = command === undefined ? undefined : gitStateMutation(command);
		return found ? { block: true, reason: gitStateRefusal(found) } : undefined;
	};
}
