import type { EntityInput } from "@octocodeai/octocode-contracts/backlogs";
import { type Db, backlog, tasks } from "../agentdb/api.ts";
import { type Item, BacklogError } from "./item.ts";
import { getItem } from "./reads.ts";

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

/**
 * An epic with items takes its state from them (`deriveEpicState`), so a direct move between backlog, todo and ongoing is
 * refused, as the board does. Closing it with its completion and reopening a closed one stay: the stored state matters
 * only then.
 */
export function checkEpicState(db: Db, item: Item, input: { state?: string }): void {
	if (item.type !== "epic" || input.state === undefined || input.state === item.state) return;
	if (input.state === "done" || item.state === "done" || !backlog.childStates(db, item.rowId).length) return;
	throw new BacklogError(
		`${item.ref} is an epic with items: its state follows them. Change its items, or close it with a completion once they are done.`,
	);
}

/** The refusal for closing an item that still has open tasks, naming them on one line; undefined when none is open. */
export function openTasksRefusal(db: Db, repo: string, item: Item): string | undefined {
	const open = tasks.listTasks(db, { repo, itemId: item.rowId, states: ["todo", "ongoing"] });
	if (!open.length) return undefined;
	const names = open.slice(0, 5).map((task) => `T${task.seq}`);
	const more = open.length > names.length ? ` and ${open.length - names.length} more` : "";
	return `${item.ref} has open tasks: ${names.join(", ")}${more}: finish or drop them first.`;
}
