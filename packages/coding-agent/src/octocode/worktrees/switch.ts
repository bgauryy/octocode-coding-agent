import type { ExtensionCommandContext } from "../../core/extensions/index.ts";
import { say } from "../shared/commands.ts";
import { existingWorktree } from "./target.ts";

/**
 * Moves this session into the existing worktree `name`: a fresh session whose folder is the worktree root, so settings,
 * trust, the team and the footer all follow. The old session stays saved; `/resume` returns to it. A
 * `session_before_switch` handler may cancel, and the worktree asks for project trust like any other folder. Declined
 * while a turn runs, since the switch would end it.
 */
export async function switchToWorktree(name: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.isIdle()) {
		say(ctx, "A turn is running: wait for it to finish (or interrupt it) before switching worktrees.", "warning");
		return;
	}
	const { folder, here } = await existingWorktree(ctx.cwd, name);
	if (here) {
		say(ctx, `This session is already in worktree ${name}.`);
		return;
	}
	const { cancelled } = await ctx.newSession({
		cwd: folder,
		withSession: async (next) => {
			say(next, `Switched to worktree ${name} (${next.cwd}). The previous session is saved: /resume returns to it.`);
		},
	});
	if (cancelled) say(ctx, "Switch cancelled: the session stays where it is.", "warning");
}
