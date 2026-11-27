import type { FeatureSetup } from "../../core/features/index.ts";
import { BACKLOG_DONE_CHANNEL, type BacklogDone } from "../shared/agent-chain.ts";
import type { Backlog } from "./context.ts";
import { completionInput } from "./tool-arguments.ts";

/**
 * After a done committed: announces it, with the work this session still has: items assigned to it (ongoing or todo)
 * and unclaimed todo items it created (planned up front, claimed one by one). Other sessions' items never count.
 */
export function announceDone(
	api: Pick<FeatureSetup, "channels">,
	backlog: Backlog,
	ref: string,
	completion: unknown,
): void {
	const { store, actor } = backlog;
	const assigned = store.list({ states: ["todo", "ongoing"], assignees: [actor.id] }).total;
	const planned = store
		.list({ states: ["todo"] })
		.items.filter((item) => !item.assignee && item.sourceSession === actor.id).length;
	const remaining = assigned + planned;
	api.channels.emit(BACKLOG_DONE_CHANNEL, {
		ref,
		summary: completionInput(completion).summary,
		open: remaining > 0,
		remaining,
	} satisfies BacklogDone);
}
