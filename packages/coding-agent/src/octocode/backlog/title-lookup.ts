import { setItemTitles } from "../shared/render/item-titles.ts";
import type { BacklogStore } from "./store.ts";

/**
 * Reloads the cached item titles (`B12` → title) that the transcript draws next to bare IDs. Called when the board may
 * have changed (session start, a backlog write, the end of a run), never per frame: rendering reads `itemTitle`.
 */
export function refreshItemTitles(store: BacklogStore): void {
	setItemTitles(new Map(store.list().items.map((item) => [item.ref, item.title])));
}
