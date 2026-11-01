import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import type { AgentDb } from "../../agentdb/api.ts";
import type { Actor, Item } from "../item.ts";
import type { AddTaskInput, ListTasksQuery, PromoteTaskInput, TaskTarget, UpdateTaskInput } from "./inputs.ts";
import { type TaskCounts, getTask, listTasks, taskCounts } from "./reads.ts";
import { addTask, adoptSessionTasks, moveTask, promoteTask, reparentTask, updateTask } from "./writes.ts";

/**
 * The tasks of one repository (`backlog_tasks`), reached as `BacklogStore.tasks`. A task is a small step with a goal and a
 * reason: it belongs to one item (`B12`) or, with no item, to one session, is numbered per repository (`T7`, never
 * reused) and has the states todo, ongoing, done and dropped. Every write is one transaction, carries the actor in the
 * audit trail (`BacklogStore.audit('B12')` lists an item's task changes, `audit('T7')` a session task's) and checks the
 * version when the caller passes one. Ownership follows the item rules: see `access.ts`.
 *
 * Refusals throw `BacklogError` (`TaskError` for task-specific ones; a version conflict carries the current task).
 */
export class TaskStore {
	private readonly agentDb: () => AgentDb;
	readonly repo: string;
	private readonly now: () => number;
	constructor(agentDb: () => AgentDb, repo: string, now: () => number) {
		this.agentDb = agentDb;
		this.repo = repo;
		this.now = now;
	}

	get(ref: string | number): BacklogTask | undefined {
		return getTask(this.agentDb().db, this.repo, ref);
	}

	/** An item's tasks, a session's, or every task of the repository; each owner's in position order. */
	list(query: ListTasksQuery = {}): BacklogTask[] {
		return listTasks(this.agentDb().db, this.repo, query);
	}

	/** Task counts per state, by item, by session and in total. */
	counts(): TaskCounts {
		return taskCounts(this.agentDb().db, this.repo);
	}

	add(input: AddTaskInput, actor: Actor): BacklogTask {
		return addTask(this.agentDb(), this.repo, this.now, input, actor);
	}

	update(ref: string, input: UpdateTaskInput, actor: Actor): BacklogTask {
		return updateTask(this.agentDb(), this.repo, this.now, ref, input, actor);
	}

	/** Puts the task at `position` (0 first) among its owner's tasks. */
	move(ref: string, position: number, actor: Actor, version?: number): BacklogTask {
		return moveTask(this.agentDb(), this.repo, this.now, ref, position, actor, version);
	}

	/** Hands the task to another item (`{ item: "B12" }`) or session (`{ session }`), last in its list. */
	reparent(ref: string, to: TaskTarget, actor: Actor, version?: number): BacklogTask {
		return reparentTask(this.agentDb(), this.repo, this.now, ref, to, actor, version);
	}

	/** Moves the open tasks of session `from` to session `to`, which must be the actor's (or the actor the user); returns them. */
	adopt(from: string, to: string, actor: Actor): BacklogTask[] {
		return adoptSessionTasks(this.agentDb(), this.repo, this.now, from, to, actor);
	}

	/** Turns an open session task into an item and moves the task under it. */
	promote(ref: string, input: PromoteTaskInput, actor: Actor): { item: Item; task: BacklogTask } {
		return promoteTask(this.agentDb(), this.repo, this.now, ref, input, actor);
	}
}
