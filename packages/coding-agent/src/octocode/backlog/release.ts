import { DAY_MS } from "../shared/util.ts";
import type { Item } from "./item.ts";
import type { ItemMarks } from "./marks.ts";

/** How long an item may sit untouched before the board lists it under Attention. */
export const IDLE_MS = 7 * DAY_MS;

/** How long the claim of a holder that ended without a graceful exit (a crash, a kill) sits idle before a new session's start returns it to todo. */
export const RELEASE_AFTER_MS = DAY_MS;

/**
 * The ongoing items whose claim can be returned: the holder ended (`marks.stale`, the one liveness test), nobody works
 * on the item (`marks.workers`: an open child run, a lingering child included) and it has sat idle for the window.
 */
export function releasable(items: readonly Item[], marks: ReadonlyMap<string, ItemMarks>, now: number): Item[] {
	return items.filter((item) => {
		const mark = marks.get(item.ref);
		return item.state === "ongoing" && mark?.stale && !mark.workers?.length && now - item.updatedAt >= RELEASE_AFTER_MS;
	});
}
