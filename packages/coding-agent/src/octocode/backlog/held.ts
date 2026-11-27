import type { Backlog } from "./context.ts";
import type { Item } from "./item.ts";

/** How many ongoing items one scan reads. */
const SCAN = 50;

/** The ongoing items this session holds (it is their assignee). */
export function heldOngoingItems(backlog: Pick<Backlog, "store" | "session">): Item[] {
	return backlog.store
		.list({ states: ["ongoing"], limit: SCAN })
		.items.filter((item) => item.assignee === backlog.session);
}
