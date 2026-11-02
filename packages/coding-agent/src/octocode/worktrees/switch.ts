import type { ExtensionCommandContext } from "../../core/features/index.ts";
import { say } from "../shared/commands.ts";
import { existingWorktree, mainCheckout } from "./target.ts";

/** The word `/worktree switch` reads as the main checkout, even when a worktree is named that. */
export const MAIN_CHECKOUT = "main";

/**
 * Moves this session into the existing worktree `name`, or into the main checkout for `main`: a fresh session whose
 * folder is that root, so settings, trust, the team and the footer all follow. The old session stays saved; the message
 * names both ways back (`/worktree switch main`, and `/resume all` for the old session: `/resume` lists only this
 * folder). A `session_before_switch` handler may cancel, and the folder asks for project trust like any other. Declined
 * while a turn runs, since the switch would end it.
 */
export async function switchToWorktree(name: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.isIdle()) {
		say(ctx, "A turn is running: wait for it to finish (or interrupt it) before switching worktrees.", "warning");
		return;
	}
	const toMain = name === MAIN_CHECKOUT;
	const { folder, here } = toMain ? await mainCheckout(ctx.cwd) : await existingWorktree(ctx.cwd, name);
	if (here) {
		say(ctx, toMain ? "This session is already in the main checkout." : `This session is already in worktree ${name}.`);
		return;
	}
	const { cancelled } = await ctx.newSession({
		cwd: folder,
		withSession: async (next) => {
			const where = toMain ? "the main checkout" : `worktree ${name}`;
			const back = toMain ? "" : ", and /worktree switch main starts a fresh session in the main checkout";
			say(next, `Switched to ${where} (${next.cwd}). The previous session is saved: /resume all lists it${back}.`);
		},
	});
	if (cancelled) say(ctx, "Switch cancelled: the session stays where it is.", "warning");
}
