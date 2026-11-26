import type { EntityInput } from "@octocodeai/octocode-contracts/backlogs";
import { type Db, backlog, tasks } from "../../../../db/src/api.ts";
import { type Item, BacklogError } from "./item.ts";
import { getItem, list } from "./reads.ts";

/**
 * The depth rules: epic → item → task. An epic has no parent; an item's parent is an epic; tasks have no children (they
 * are not items). Existing rows may predate the rules (a parent that is not an epic, an epic with a parent): they stay
 * readable and editable, and the rules are checked only when an update sets a parent or a type, so no old row is
 * rewritten or refused and no new invalid one is made.
 */
export function checkHierarchy(db: Db, repo: string, before: Item, input: EntityInput): void {
	const parentChanged = input.parentId !== undefined && input.parentId !== (before.parentId ?? null);
	const typeChanged = input.type !== undefined && input.type !== before.type;
	if (!parentChanged && !typeChanged) return;
	const type = input.type ?? before.type;
	const parentRef = input.parentId === undefined ? (before.parentId ?? null) : input.parentId;
	if (parentChanged && parentRef !== null) {
		const parent = getItem(db, repo, parentRef);
		if (parent && parent.type !== "epic")
			throw new BacklogError(`${parent.ref} is a ${parent.type}, not an epic: items nest only under epics.`);
	}
	if (type === "epic" && parentRef !== null)
		throw new BacklogError(`${before.ref} is an epic and an epic has no parent: clear parentId in the same update.`);
	if (typeChanged && type === "epic" && tasks.listTasks(db, { repo, itemId: before.rowId }).length)
		throw new BacklogError(`${before.ref} has tasks and an epic has none: move them to another item first.`);
	if (typeChanged && before.type === "epic" && backlog.childStates(db, before.rowId).length)
		throw new BacklogError(`${before.ref} is an epic with child items: move them elsewhere before changing its type.`);
}

/** Checks changed hierarchy/dependency edges without recursion, including boards with long chains. */
export function checkWaitingCycle(db: Db, repo: string): void {
	const items = list(db, repo).items;
	const edges = new Map(items.map((item) => [item.ref, item.dependsOn.map((ref) => ref.id)]));
	for (const item of items) if (item.parentId) edges.get(item.parentId)?.push(item.ref);
	const incoming = new Map(items.map((item) => [item.ref, 0]));
	for (const targets of edges.values())
		for (const target of targets) if (incoming.has(target)) incoming.set(target, incoming.get(target)! + 1);
	const ready = items.filter((item) => incoming.get(item.ref) === 0).map((item) => item.ref);
	for (let index = 0; index < ready.length; index += 1) {
		for (const target of edges.get(ready[index]) ?? []) {
			const count = incoming.get(target);
			if (count === undefined) continue;
			incoming.set(target, count - 1);
			if (count === 1) ready.push(target);
		}
	}
	if (ready.length !== items.length) throw new BacklogError("Hierarchy and dependencies would create a waiting cycle.");
}

/**
 * An epic with items takes its state from them (`deriveEpicState`), so a direct move between backlog, todo and ongoing is
 * refused, as the board does. Finishing it (state done: the tool supplies the completion once its items are done, see
 * `closingEpic`) is refused while an item is open; reopening a done one stays: the stored state matters only then.
 */
export function checkEpicState(db: Db, repo: string, item: Item, input: { state?: string }): void {
	if (item.type !== "epic" || input.state === undefined || input.state === item.state) return;
	const children = backlog.childStates(db, item.rowId);
	if (item.state === "done" || !children.length) return;
	const open = children.filter((state) => state !== "done").length;
	if (input.state === "done" && !open) return;
	const items = open ? `${open} of its ${children.length} items are not done` : `all ${children.length} items are done`;
	const names = open
		? list(db, repo, { parentId: item.ref, states: ["backlog", "todo", "ongoing", "closed"] }).items.map(
				(child) => child.ref,
			)
		: [];
	const named = names.length
		? ` (open: ${names.slice(0, 5).join(", ")}${names.length > 5 ? `, +${names.length - 5} more` : ""})`
		: "";
	throw new BacklogError(
		input.state === "done"
			? `${item.ref} is an epic with items that are not done (${items})${named}: finish or close them first, then finish the epic with backlog done.`
			: `${item.ref} is an epic with items: its state follows them (${items})${named}. Claim or edit its items (backlogPlan list underEpic ${item.ref}); once they are done, finish the epic with backlog done.`,
	);
}

/**
 * The refusal for closing an item with open steps. Completed steps can be reported by tool; the board drops unneeded ones.
 */
export function openTasksRefusal(db: Db, repo: string, item: Item): string | undefined {
	const open = tasks.listTasks(db, { repo, itemId: item.rowId, states: ["todo", "ongoing"] });
	if (!open.length) return undefined;
	const names = open.slice(0, 5).map((task) => `T${task.seq}`);
	const more = open.length > names.length ? ` and ${open.length - names.length} more` : "";
	return `${item.ref} has open tasks: ${names.join(", ")}${more}: finish completed steps with backlog step (id T…, note: result and checks); the user drops unneeded steps on the backlog board (/backlog).`;
}
