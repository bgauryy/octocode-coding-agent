import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import type { BacklogCommand, BacklogMutation } from "@octocodeai/octocode-contracts/protocol";
import { USER_AUTHOR } from "../../../../db/src/api.ts";
import { BacklogError, type Actor, type Item } from "./item.ts";
import type { BacklogStore } from "./store.ts";

/** What a command changed: the item it touched or made, and the task it touched. */
export interface BacklogCommandResult {
	item?: Item;
	task?: BacklogTask;
}

/** The webview acts as the user: the host checks every depth, version and ownership rule in the store, never the page. */
const HUMAN: Actor = { id: USER_AUTHOR, kind: "human", surface: "web" };

/**
 * Applies one typed hierarchy command from the web page with the human actor. `session` is the session that owns a task
 * added without an owner. Refusals throw the store's one-line `BacklogError`; a version conflict carries the current copy.
 */
export function applyBacklogCommand(
	store: BacklogStore,
	command: BacklogCommand,
	session: string,
): BacklogCommandResult {
	switch (command.command) {
		case "task.add": {
			if (command.item && command.session) throw new BacklogError("A task belongs to an item or a session, not both.");
			const { command: _kind, ...input } = command;
			return { task: store.tasks.add(command.item ? input : { ...input, session: command.session ?? session }, HUMAN) };
		}
		case "task.update": {
			const { command: _kind, task, ...changes } = command;
			return { task: store.tasks.update(task, changes, HUMAN) };
		}
		case "task.move":
			return { task: store.tasks.move(command.task, command.position, HUMAN, command.version) };
		case "task.reparent": {
			if (!command.item === !command.session) throw new BacklogError("Name one new owner: an item or a session.");
			const to = command.item ? { item: command.item } : { session: command.session };
			return { task: store.tasks.reparent(command.task, to, HUMAN, command.version) };
		}
		case "task.promote": {
			const { command: _kind, task, ...input } = command;
			return store.tasks.promote(task, input, HUMAN);
		}
		case "item.reparent":
			return { item: store.update(command.id, { parentId: command.parentId, version: command.version }, HUMAN) };
		case "item.close":
			return {
				item: store.update(
					command.id,
					{ close: { kind: command.kind, text: command.text, of: command.of }, version: command.version },
					HUMAN,
				),
			};
		case "item.rank":
			return {
				item: store.rank(command.id, { version: command.version, before: command.before, after: command.after }, HUMAN),
			};
		case "item.state":
			return {
				item: store.update(command.id, { state: command.state, version: command.version, note: command.note }, HUMAN),
			};
	}
}

/** Why a mutation cannot be applied before it reaches the store (an update or comment needs its item and version), or undefined. */
export function mutationShapeError(input: BacklogMutation): string | undefined {
	return input.op !== "add" && (!input.id || input.version === undefined)
		? "An item and its current version are required."
		: undefined;
}

/**
 * Applies one add, update or comment from the web page as the user. `actor` is the caller's actor (a session's, or the
 * user alone for a repository with no session); it is recorded as a human on the web surface. `session` becomes the
 * source session of an added item. Refusals throw the store's `BacklogError`.
 */
export function applyBacklogMutation(
	store: BacklogStore,
	input: BacklogMutation,
	context: { actor: Actor; session?: string },
): { item: Item } {
	const actor: Actor = { ...context.actor, kind: "human", surface: "web" };
	const { op, id, ...fields } = input;
	const shapeError = mutationShapeError(input);
	if (shapeError) throw new BacklogError(shapeError);
	if (op === "add")
		return {
			item: store.add(
				{ ...fields, title: fields.title ?? "", createdBy: USER_AUTHOR, sourceSession: context.session },
				actor,
			),
		};
	if (op === "comment") return { item: store.comment(id!, fields.note ?? "", HUMAN, fields.version) };
	return { item: store.update(id!, fields, actor) };
}
