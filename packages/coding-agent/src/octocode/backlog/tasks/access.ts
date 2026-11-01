import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import type { Db } from "../../agentdb/api.ts";
import { type Actor, type Item, BacklogError, auditActor, parseRef } from "../item.ts";
import { getItem, liveHolder } from "../reads.ts";

/**
 * Who may touch which tasks, in the item rules' terms. The user may touch any task. A subagent touches only the tasks
 * of the item its parent holds (and, when it was started for one item, only that item's) and its own session's tasks.
 * Any other agent touches the tasks of an item no other live session holds, and its own session's tasks.
 */
export function itemAccess(db: Db, item: Item, actor: Actor): void {
	if (auditActor(actor).kind === "human") return;
	if (actor.owners) {
		if (!(item.assignee && actor.owners.has(item.assignee)))
			throw new BacklogError(
				`${item.ref} is not claimed by your parent: a subagent touches only the tasks of items its parent has claimed. Ask your parent to claim it (agent message to parent), or add session steps without an item.`,
			);
		if (actor.item !== undefined && parseRef(actor.item) !== item.seq)
			throw new BacklogError(
				`${item.ref} is not your item: your parent started you for B${parseRef(actor.item) ?? actor.item}, the only item whose tasks you may touch.`,
			);
		return;
	}
	const holder =
		item.state === "ongoing" && item.assignee && item.assignee !== actor.id ? liveHolder(db, item.assignee) : undefined;
	if (holder)
		throw new BacklogError(`${item.ref} is ongoing for ${holder}, which is still running: leave it or ask the user.`);
}

/** A session's tasks belong to that session; only it (or the user) changes them. */
export function sessionAccess(session: string, actor: Actor): void {
	if (auditActor(actor).kind === "human" || actor.id === session) return;
	throw new BacklogError(`Those tasks belong to session ${session}: only that session or the user changes them.`);
}

/** Checks `actor` may touch `task` through its owner. */
export function taskAccess(db: Db, repo: string, task: BacklogTask, actor: Actor): void {
	if (task.owner.kind === "session") return sessionAccess(task.owner.id, actor);
	const item = getItem(db, repo, task.owner.ref);
	if (!item) throw new BacklogError(`${task.ref} belongs to ${task.owner.ref}, which no longer exists.`);
	itemAccess(db, item, actor);
}

/** The item a task may be added or moved under: it exists, is not an epic (epics group items) and is not done. */
export function openItemFor(db: Db, repo: string, ref: string, actor: Actor): Item {
	const item = getItem(db, repo, ref);
	if (!item) throw new BacklogError(`No backlog item ${ref}.`);
	if (item.type === "epic")
		throw new BacklogError(`${item.ref} is an epic: it groups items, so put the task under one of its items.`);
	if (item.state === "done") throw new BacklogError(`Reopen ${item.ref} before adding tasks to it.`);
	itemAccess(db, item, actor);
	return item;
}
