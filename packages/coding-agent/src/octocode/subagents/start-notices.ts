import type { ExtensionContext, SessionStartEvent } from "../../core/extensions/index.ts";
import { stoppedChildrenNotice, type StartNote } from "./handoff/stopped-notice.ts";
import { pruneNotice } from "./prune-notice.ts";

/** What the user is told as a session starts: children the previous session left stopped, and orphaned worktrees pruned. */
export async function startNotices(
	event: SessionStartEvent,
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): Promise<StartNote[]> {
	const [stopped, pruned] = await Promise.all([
		stoppedChildrenNotice(event, ctx.sessionManager.getSessionId()),
		pruneNotice(ctx),
	]);
	return [stopped, pruned].filter((note): note is StartNote => note !== undefined);
}
