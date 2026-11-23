import { Value } from "typebox/value";
import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import {
	BacklogCommandSchema,
	BacklogMutationSchema,
	type BacklogCommand,
	type BacklogMutation,
} from "@octocodeai/octocode-contracts/protocol";
import { USER_AUTHOR } from "../../../../db/src/api.ts";
import { BacklogError, type Actor, type Item } from "./item.ts";
import type { BacklogStore } from "./store.ts";

/** What a command changed: the item it touched or made, and the task it touched. */
export interface BacklogCommandResult {
	item?: Item;
	task?: BacklogTask;
}

/**
 * The webview acts as the user under the id of the session whose page sent the write, as `/backlog` does in that
 * session's terminal: a claim from the page is that session's, held while it runs. A repository page has no session and
 * writes as the user alone. The host checks every depth, version and ownership rule in the store, never the page.
 */
const webActor = (session: string | undefined): Actor => ({
	id: session || USER_AUTHOR,
	kind: "human",
	surface: "web",
});

/** A comment is the person's words, whichever page they typed it on. */
const HUMAN: Actor = webActor(undefined);

/**
 * Applies one typed hierarchy command from the web page as the user (`webActor`). `session` is the session that owns a
 * task added without an owner. Refusals throw the store's one-line `BacklogError`; a version conflict carries the current copy.
 */
export function applyBacklogCommand(
	store: BacklogStore,
	command: BacklogCommand,
	session: string,
): BacklogCommandResult {
	const actor = webActor(session);
	switch (command.command) {
		case "task.add": {
			if (command.item && command.session) throw new BacklogError("A task belongs to an item or a session, not both.");
			const { command: _kind, ...input } = command;
			return { task: store.tasks.add(command.item ? input : { ...input, session: command.session ?? session }, actor) };
		}
		case "task.update": {
			const { command: _kind, task, ...changes } = command;
			return { task: store.tasks.update(task, changes, actor) };
		}
		case "task.move":
			return { task: store.tasks.move(command.task, command.position, actor, command.version) };
		case "task.reparent": {
			if (!command.item === !command.session) throw new BacklogError("Name one new owner: an item or a session.");
			const to = command.item ? { item: command.item } : { session: command.session };
			return { task: store.tasks.reparent(command.task, to, actor, command.version) };
		}
		case "task.promote": {
			const { command: _kind, task, ...input } = command;
			return store.tasks.promote(task, input, actor);
		}
		case "item.reparent":
			return { item: store.update(command.id, { parentId: command.parentId, version: command.version }, actor) };
		case "item.close":
			return {
				item: store.update(
					command.id,
					{ close: { kind: command.kind, text: command.text, of: command.of }, version: command.version },
					actor,
				),
			};
		case "item.rank":
			return {
				item: store.rank(command.id, { version: command.version, before: command.before, after: command.after }, actor),
			};
		case "item.state":
			return {
				item: store.update(command.id, { state: command.state, version: command.version, note: command.note }, actor),
			};
	}
}

/** Why a mutation cannot be applied before it reaches the store (an update or comment needs its item and version), or undefined. */
function mutationShapeError(input: BacklogMutation): string | undefined {
	return input.op !== "add" && (!input.id || input.version === undefined)
		? "An item and its current version are required."
		: undefined;
}

/**
 * Applies one add, update or comment from the web page as the user: a human on the web surface, under the id of the
 * session whose page sent it (the user alone for a repository page with no session). `session` also becomes the source
 * session of an added item. Refusals throw the store's `BacklogError`.
 */
function applyBacklogMutation(
	store: BacklogStore,
	input: BacklogMutation,
	session: string | undefined,
): { item: Item } {
	const actor = webActor(session);
	const { op, id, ...fields } = input;
	const shapeError = mutationShapeError(input);
	if (shapeError) throw new BacklogError(shapeError);
	if (op === "add")
		return {
			item: store.add({ ...fields, title: fields.title ?? "", createdBy: USER_AUTHOR, sourceSession: session }, actor),
		};
	if (op === "comment") return { item: store.comment(id!, fields.note ?? "", HUMAN, fields.version) };
	return { item: store.update(id!, fields, actor) };
}

/** A board write's outcome: what it changed, or why its body was refused before the store saw it. */
export type BoardWrite = { ok: true; result: BacklogCommandResult } | { ok: false; error: string };

/**
 * One `POST` on the board route, the same for every web server: a typed hierarchy command or an add/update/comment,
 * applied as the user. `session` is the session whose page sent it; a repository page has none, so a task added there
 * must name its item or session. Store refusals throw (`BacklogError`, `TaskError`) for the caller to answer.
 */
export async function applyBoardWrite(
	store: BacklogStore,
	input: unknown,
	session: string | undefined,
): Promise<BoardWrite> {
	// A write another process holds the lock for waits on a timer (`transactionWhenReady`), never on this thread.
	if (typeof input === "object" && input !== null && "command" in input) {
		if (!Value.Check(BacklogCommandSchema, input)) return { ok: false, error: "Invalid backlog command" };
		if (session === undefined && input.command === "task.add" && !input.item && !input.session)
			return { ok: false, error: "Name the item or the session the task belongs to." };
		const command = input;
		return {
			ok: true,
			result: await store.transactionWhenReady(() => applyBacklogCommand(store, command, session ?? "")),
		};
	}
	if (!Value.Check(BacklogMutationSchema, input)) return { ok: false, error: "Invalid backlog fields" };
	const shapeError = mutationShapeError(input);
	if (shapeError) return { ok: false, error: shapeError };
	const mutation = input;
	return { ok: true, result: await store.transactionWhenReady(() => applyBacklogMutation(store, mutation, session)) };
}
