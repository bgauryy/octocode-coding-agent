import type { ItemType, TaskState } from "@octocodeai/octocode-contracts/backlogs";
import type { State } from "@octocodeai/octocode-contracts/snapshot";

/**
 * Creates a task. The owner is `item` (`B12`) or `session` (a session id), not both; with neither, the acting session
 * (`actor.id`) owns it. A task starts `todo`, or `ongoing` (claimed by the actor).
 */
export interface AddTaskInput {
	goal: string;
	reason?: string;
	item?: string;
	session?: string;
	state?: Extract<TaskState, "todo" | "ongoing">;
}

/** Changes a task; `ongoing` claims it for the actor, `todo` releases it, `done` stamps `doneAt`. */
export interface UpdateTaskInput {
	goal?: string;
	reason?: string;
	/** What was done, or why it was dropped. */
	result?: string;
	state?: TaskState;
	/** Refuse when the task changed since this version was read. */
	version?: number;
}

/** Which tasks to list: one item's (`B12`), one session's, or (neither) every task of the repository. */
export interface ListTasksQuery {
	item?: string;
	session?: string;
	states?: readonly TaskState[];
}

/** The new owner for `reparent`: exactly one of `item` (`B12`) or `session`. */
export interface TaskTarget {
	item?: string;
	session?: string;
}

/** Promotes a session task to an item; the item takes the task's goal as its goal and its reason as `why` unless given. */
export interface PromoteTaskInput {
	title?: string;
	goal?: string;
	why?: string;
	type?: ItemType;
	/** The epic the new item belongs to (`B3`). */
	parentId?: string;
	priority?: number;
	/** `backlog` (triage, the default) or `todo`. */
	state?: Extract<State, "backlog" | "todo">;
	version?: number;
}
