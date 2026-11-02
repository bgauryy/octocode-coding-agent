import type { BacklogCounts } from "../../src/octocode/backlog/counts.ts";

/** Counts with `items` per state and no epics, for tests of how the counts read. */
export const itemCounts = (items: BacklogCounts["items"]): BacklogCounts => ({
	items,
	epics: { backlog: 0, todo: 0, ongoing: 0, done: 0 },
});
