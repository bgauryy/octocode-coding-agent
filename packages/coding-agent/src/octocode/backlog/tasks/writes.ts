import { TASK_STATES, isOpenTask, type BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import { storedText } from "../../../../../common/src/sanitize.ts";
import { cutText } from "../../../../../common/src/text.ts";
import { type AgentDb, type Db, tasks } from "../../../../../db/src/api.ts";
import { type Actor, type Item, auditActor, refuseSecrets, storedTitle } from "../item.ts";
import { addItem } from "../writes.ts";
import { getItem } from "../reads.ts";
import type { AddTaskInput, PromoteTaskInput, TaskTarget, UpdateTaskInput } from "./inputs.ts";
import { itemAccess, openItemFor, sessionAccess, taskAccess } from "./access.ts";
import { TaskError, requireTask } from "./reads.ts";
import { toTask } from "./rows.ts";

const conflict = (task: BacklogTask) => new TaskError(`${task.ref} changed elsewhere — reload it.`, task);

/** The task's owner as the query layer keys it, after checking `actor` may add to it. */
function target(db: Db, repo: string, to: TaskTarget, actor: Actor): { itemId: number } | { sessionId: string } {
	if (to.item !== undefined && to.session !== undefined)
		throw new TaskError("A task belongs to an item or a session, not both.");
	if (to.item !== undefined) return { itemId: openItemFor(db, repo, to.item, actor).rowId };
	const session = to.session ?? actor.id;
	sessionAccess(session, actor);
	return { sessionId: session };
}

/** Creates a task at the end of its owner's list. */
export function addTask(
	agentDb: AgentDb,
	repo: string,
	now: () => number,
	input: AddTaskInput,
	actor: Actor,
): BacklogTask {
	const goal = storedTitle(input.goal);
	if (!goal) throw new TaskError("A task needs a goal.");
	const state = input.state ?? "todo";
	if (state !== "todo" && state !== "ongoing") throw new TaskError("A new task starts todo or ongoing.");
	refuseSecrets({ goal: input.goal, reason: input.reason });
	return agentDb.withActor(auditActor(actor), () =>
		agentDb.transaction(() => {
			const owner = target(agentDb.db, repo, input, actor);
			const row = tasks.insertTask(agentDb.db, {
				repo,
				seq: tasks.nextTaskSeq(agentDb.db, repo),
				owner,
				goal,
				reason: storedText(input.reason),
				state,
				assignee: state === "ongoing" ? actor.id : null,
				at: now(),
			});
			return toTask(row);
		}),
	);
}

/**
 * Changes a task. `ongoing` claims it for `actor`, `todo` releases it, `done` stamps `doneAt` and leaving `done` clears
 * it; reopening a task of a done item is refused (reopen the item first). Refused when `input.version` is stale.
 */
export function updateTask(
	agentDb: AgentDb,
	repo: string,
	now: () => number,
	ref: string,
	input: UpdateTaskInput,
	actor: Actor,
): BacklogTask {
	if (input.state !== undefined && !TASK_STATES.includes(input.state)) throw new TaskError("Unknown task state.");
	refuseSecrets({ goal: input.goal, reason: input.reason, result: input.result });
	return agentDb.withActor(auditActor(actor), () =>
		agentDb.transaction(() => {
			const db = agentDb.db;
			const task = requireTask(db, repo, ref);
			if (input.version !== undefined && input.version !== task.version) throw conflict(task);
			taskAccess(db, repo, task, actor);
			const state = input.state ?? task.state;
			const goal = input.goal === undefined ? task.goal : storedTitle(input.goal);
			if (!goal) throw new TaskError("A task needs a goal.");
			if (task.owner.kind === "item" && isOpenTask(state) && !isOpenTask(task.state)) {
				if (getItem(db, repo, task.owner.ref)?.state === "done")
					throw new TaskError(`Reopen ${task.owner.ref} before reopening its task ${task.ref}.`);
			}
			const assignee = state === "ongoing" ? actor.id : state === "todo" ? null : (task.assignee ?? null);
			const reason = input.reason === undefined ? task.reason : storedText(input.reason);
			const result = input.result === undefined ? task.result : storedText(input.result);
			// An authorized retry with the same result must not advance the version or duplicate the audit entry.
			if (
				state === task.state &&
				goal === task.goal &&
				reason === task.reason &&
				result === task.result &&
				assignee === (task.assignee ?? null)
			)
				return task;
			const at = now();
			const changed = tasks.updateTask(
				db,
				task.rowId,
				{
					goal,
					reason,
					result,
					state,
					assignee,
					at,
					doneAt: state === "done" ? (task.doneAt ?? at) : null,
				},
				task.version,
			);
			if (!changed) throw conflict(task);
			return requireTask(db, repo, task.ref);
		}),
	);
}

/** Puts a task at `position` (0 first) among its owner's tasks. */
export function moveTask(
	agentDb: AgentDb,
	repo: string,
	now: () => number,
	ref: string,
	position: number,
	actor: Actor,
	version?: number,
): BacklogTask {
	if (!Number.isInteger(position) || position < 0) throw new TaskError("A position is a whole number from 0.");
	return agentDb.withActor(auditActor(actor), () =>
		agentDb.transaction(() => {
			const task = requireTask(agentDb.db, repo, ref);
			if (version !== undefined && version !== task.version) throw conflict(task);
			taskAccess(agentDb.db, repo, task, actor);
			tasks.moveTask(agentDb.db, task.rowId, position, now());
			return requireTask(agentDb.db, repo, ref);
		}),
	);
}

/** Hands a task to another item or session, last in that owner's list. */
export function reparentTask(
	agentDb: AgentDb,
	repo: string,
	now: () => number,
	ref: string,
	to: TaskTarget,
	actor: Actor,
	version?: number,
): BacklogTask {
	return agentDb.withActor(auditActor(actor), () =>
		agentDb.transaction(() => {
			const task = requireTask(agentDb.db, repo, ref);
			if (version !== undefined && version !== task.version) throw conflict(task);
			taskAccess(agentDb.db, repo, task, actor);
			tasks.reparentTask(agentDb.db, task.rowId, target(agentDb.db, repo, to, actor), now());
			return requireTask(agentDb.db, repo, ref);
		}),
	);
}

/**
 * Hands every open task of session `from` to session `to` (a finished subagent's to the session that started it), in
 * their order, each audited as a reparent; closed tasks stay. Only the user or session `to` itself may take them.
 */
export function adoptSessionTasks(
	agentDb: AgentDb,
	repo: string,
	now: () => number,
	from: string,
	to: string,
	actor: Actor,
): BacklogTask[] {
	sessionAccess(to, actor);
	if (from === to) return [];
	return agentDb.withActor(auditActor(actor), () =>
		agentDb.transaction(() =>
			tasks.listTasks(agentDb.db, { repo, sessionId: from, states: ["todo", "ongoing"] }).map((row) => {
				tasks.reparentTask(agentDb.db, row.id, { sessionId: to }, now());
				return requireTask(agentDb.db, repo, `T${row.seq}`);
			}),
		),
	);
}

/**
 * Promotes an open session task to an item: creates the item (a proposal in `backlog` unless `state` says `todo`) from
 * the task's goal and reason, then moves the task under it. A subagent never promotes (its parent decides).
 */
export function promoteTask(
	agentDb: AgentDb,
	repo: string,
	now: () => number,
	ref: string,
	input: PromoteTaskInput,
	actor: Actor,
): { item: Item; task: BacklogTask } {
	if (actor.owners) throw new TaskError("A subagent cannot promote a task to an item; report it to your coordinator.");
	if (input.type === "epic")
		throw new TaskError("An epic groups items and takes no tasks: promote to feature, bug or research.");
	return agentDb.withActor(auditActor(actor), () =>
		agentDb.transaction(() => {
			const db = agentDb.db;
			const task = requireTask(db, repo, ref);
			if (input.version !== undefined && input.version !== task.version) throw conflict(task);
			if (task.owner.kind !== "session") throw new TaskError(`${task.ref} already belongs to ${task.owner.ref}.`);
			sessionAccess(task.owner.id, actor);
			if (!isOpenTask(task.state)) throw new TaskError(`${task.ref} is ${task.state}: only an open task is promoted.`);
			const goal = input.goal ?? task.goal;
			const created = addItem(
				agentDb,
				repo,
				now,
				{
					title: input.title ?? cutText(task.goal, 80, { chars: true }),
					goal,
					// An item needs a why to be claimed: a task added without one gets it from its goal.
					why: input.why ?? (task.reason || `Follow-up step of a session: ${task.goal}`),
					state: input.state ?? "backlog",
					...(input.type ? { type: input.type } : {}),
					...(input.parentId ? { parentId: input.parentId } : {}),
					...(input.priority === undefined ? {} : { priority: input.priority }),
					createdBy: actor.id,
					sourceSession: task.owner.id,
				},
				actor,
			);
			const item = getItem(db, repo, created.ref)!;
			itemAccess(db, item, actor);
			tasks.reparentTask(db, task.rowId, { itemId: item.rowId }, now());
			return { item, task: requireTask(db, repo, task.ref) };
		}),
	);
}
