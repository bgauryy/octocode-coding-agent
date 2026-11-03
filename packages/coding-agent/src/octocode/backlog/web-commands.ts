import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import type { BacklogCommand } from "@octocodeai/octocode-contracts/protocol";
import { USER_AUTHOR } from "../../../../db/src/api.ts";
import { BacklogError, type Actor, type Item } from "./item.ts";
import type { BacklogStore } from "./store.ts";

/** What a command changed: the item it touched or made, and the task it touched. */
export interface BacklogCommandResult {
	item?: Item;
	task?: BacklogTask;
}

/** The webview acts as the user: the host checks every depth, version and ownership rule in the store, never the page. */
const HUMAN: Actor = { id: USER_AUTHOR, kind: "human" };

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
		case "item.state":
			return { item: store.update(command.id, { state: command.state, version: command.version }, HUMAN) };
	}
}
