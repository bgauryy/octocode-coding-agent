import { type Db, backlog } from "../agentdb/api.ts";
import { type Item, parseRef } from "./item.ts";
import { getItem, list, liveHolder } from "./reads.ts";
import { taskCounts } from "./tasks/reads.ts";

/**
 * What a line about an item says beyond its own row: the prerequisites still open, its open steps, a claim whose holder
 * ended, and for a done item what is open beneath it. `hideParent` drops the `⊂B<n>` marker where the list is already
 * under that parent.
 */
export interface ItemMarks {
	blockedBy?: string[];
	openSteps?: number;
	stale?: boolean;
	openBelow?: string[];
	hideParent?: boolean;
}

/**
 * The marks of `items`, by ref; an item with nothing to mark has no entry. `self` and `parents` are the reader's own
 * sessions, whose claims are never stale. A page costs a fixed few statements (steps, prerequisites, open items below
 * the done ones) plus one per distinct holder to check.
 */
export function itemMarks(
	db: Db,
	repo: string,
	items: readonly Item[],
	self?: string,
	parents?: ReadonlySet<string>,
): Map<string, ItemMarks> {
	const marks = new Map<string, ItemMarks>();
	if (!items.length) return marks;
	const steps = taskCounts(db, repo).items;
	const seqs = items.flatMap((item) => item.dependsOn.flatMap((ref) => parseRef(ref.id) ?? []));
	const done = backlog.doneSeqs(db, repo, [...new Set(seqs)]);
	const open = (ref: string) => !done.has(parseRef(ref) ?? -1);
	const below = backlog.openDescendants(
		db,
		repo,
		items.filter((item) => item.state === "done").map((item) => item.rowId),
	);
	const live = new Map<string, boolean>();
	const holderLives = (assignee: string) => {
		if (!live.has(assignee)) live.set(assignee, liveHolder(db, assignee) !== undefined);
		return live.get(assignee)!;
	};
	for (const item of items) {
		const mark: ItemMarks = {};
		const blockedBy = item.dependsOn.map((ref) => ref.id).filter(open);
		if (blockedBy.length) mark.blockedBy = blockedBy;
		const tally = steps[item.ref];
		if (tally && tally.todo + tally.ongoing > 0) mark.openSteps = tally.todo + tally.ongoing;
		if (
			item.state === "ongoing" &&
			item.assignee &&
			item.assignee !== self &&
			!parents?.has(item.assignee) &&
			!holderLives(item.assignee)
		)
			mark.stale = true;
		const openBelow = item.state === "done" ? below.get(item.rowId) : undefined;
		if (openBelow?.length) mark.openBelow = openBelow.map((seq) => `B${seq}`);
		if (Object.keys(mark).length) marks.set(item.ref, mark);
	}
	return marks;
}

/**
 * The done items that now need a second look because `item` is not done: its parents up the chain and the items that
 * depend on it, each with what it was waiting for. Empty when `item` is done.
 */
export function reviewNeeded(db: Db, repo: string, item: Item): string[] {
	if (item.state === "done") return [];
	const found: string[] = [];
	const seen = new Set<string>([item.ref]);
	for (let at: Item | undefined = item; at?.parentId && !seen.has(at.parentId);) {
		seen.add(at.parentId);
		const parent = getItem(db, repo, at.parentId);
		if (parent?.state === "done") found.push(`${parent.ref} (parent of ${at.ref})`);
		at = parent;
	}
	for (const dependant of list(db, repo, { dependsOn: [item.ref], states: ["done"] }).items)
		found.push(`${dependant.ref} (depends on ${item.ref})`);
	return found;
}
