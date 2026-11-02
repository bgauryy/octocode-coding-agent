import type { ExtensionContext } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { openBacklog } from "../backlog/context.ts";
import { noteSavedRef } from "./ref-link.ts";
import { describePrune, pruneWorktrees } from "./worktree.ts";

/**
 * Prunes the orphaned subagent worktrees of this repository (any checkout's) and says what happened: a saved ref is
 * linked on the backlog item its child worked on, as a finished run would. Resolves to the note to show, never rejects.
 */
export async function pruneNotice(
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	home?: string,
): Promise<{ text: string; level: "info" | "warning" } | undefined> {
	try {
		const report = await pruneWorktrees(ctx.cwd, home);
		const note = describePrune(report);
		const linked = report.saved.flatMap(({ ref, item }) => (ref && item ? [{ ref, item }] : []));
		if (linked.length === 0) return note;
		const failures: string[] = [];
		try {
			const backlog = openBacklog(ctx, { isSubagent: false });
			for (const { ref, item } of linked) {
				try {
					noteSavedRef(backlog, item, ref);
				} catch (error) {
					failures.push(`Could not link ${ref} on ${item}: ${errorMessage(error)}`);
				}
			}
		} catch (error) {
			failures.push(`Could not link saved refs on backlog items: ${errorMessage(error)}`);
		}
		if (failures.length === 0) return note;
		return { text: [note?.text, ...failures].filter(Boolean).join("\n"), level: "warning" };
	} catch (error) {
		return { text: `Could not prune orphaned subagent worktrees: ${errorMessage(error)}`, level: "warning" };
	}
}
