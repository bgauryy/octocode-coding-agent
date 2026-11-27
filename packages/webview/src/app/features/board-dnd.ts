import type { SnapshotItem, State } from "@octocodeai/octocode-contracts/snapshot";
import type { BacklogIndex } from "../model/backlog.ts";
import { isEpic, shownState } from "../model/hierarchy.ts";

/** A drop target on the board: a state column, or the Closed list (a close, not a state). */
export type DropTarget = State | "closed";

/** What a drop means for one card. The host still decides; this only avoids sending what it is known to refuse. */
export type DropPlan =
	| { kind: "none" }
	/** Backlog or To do from an open item: a plain `item.state`. */
	| { kind: "move"; state: State }
	/** In progress claims the item for the person using the page; goal and why must be set first. */
	| { kind: "claim"; missing: string[] }
	/** Done needs a completion record, so the completion editor opens instead. */
	| { kind: "complete" }
	/** Out of done or closed: the store requires a note. `missing` is the goal/why a move to In progress also needs. */
	| { kind: "reopen"; state: State; missing: string[] }
	| { kind: "close" }
	| { kind: "refuse"; reason: string };

/** The column an item shows in. */
export function currentTarget(item: SnapshotItem): DropTarget {
	return item.closed ? "closed" : shownState(item);
}

function missingForClaim(item: SnapshotItem): string[] {
	return [!item.goal.trim() && "goal", !item.why.trim() && "why"].filter((name): name is string => Boolean(name));
}

/** Drop mapping: backlog/todo `item.state`; ongoing claims; done opens the editor; from done or closed needs a note. */
export function planDrop(item: SnapshotItem, target: DropTarget): DropPlan {
	if (isEpic(item)) return { kind: "refuse", reason: `${item.ref} is an epic: its state follows its items.` };
	if (currentTarget(item) === target) return { kind: "none" };
	const finished = item.state === "done";
	if (target === "closed")
		return finished ? { kind: "refuse", reason: `${item.ref} is done: reopen it before closing.` } : { kind: "close" };
	if (target === "done")
		return item.closed
			? { kind: "refuse", reason: `${item.ref} is closed: reopen it before completing it.` }
			: { kind: "complete" };
	const missing = target === "ongoing" ? missingForClaim(item) : [];
	if (finished) return { kind: "reopen", state: target, missing };
	return target === "ongoing" ? { kind: "claim", missing } : { kind: "move", state: target };
}

/** `3/5` for the tasks chip, or nothing when the item has no tasks. */
export function taskChip(item: SnapshotItem): string | undefined {
	const tasks = item.tasks ?? [];
	if (!tasks.length) return undefined;
	return `${tasks.filter((task) => task.state === "done").length}/${tasks.length}`;
}

const TAG_PALETTE_SIZE = 8;
/** The same tag always gets the same palette slot (`tag-0` … `tag-7` in the stylesheet). */
export function tagSlot(tag: string): number {
	let hash = 0;
	for (const char of tag.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return hash % TAG_PALETTE_SIZE;
}

/** The next target for an arrow key while a card is lifted; it stops at both ends. */
export function stepTarget(targets: readonly DropTarget[], from: DropTarget, delta: -1 | 1): DropTarget {
	const at = targets.indexOf(from);
	return targets[Math.min(targets.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta))] ?? from;
}

/** How many of an item's children are done (closed ones count: they are done underneath). */
export function doneChildren(index: BacklogIndex, item: SnapshotItem): number {
	return item.children?.filter((ref) => index.byRef.get(ref)?.state === "done").length ?? 0;
}
