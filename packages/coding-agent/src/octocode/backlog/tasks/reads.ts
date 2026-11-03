import { TASK_STATES, type BacklogTask, type TaskState, type TaskTally } from "@octocodeai/octocode-contracts/backlogs";
import { type Db, tasks } from "../../../../../db/src/api.ts";
import { BacklogError } from "../item.ts";
import { getItem } from "../reads.ts";
import type { ListTasksQuery } from "./inputs.ts";
import { parseTaskRef, toTask } from "./rows.ts";

/** A task refusal; `task` is the current copy when the refusal is a version conflict (`T3 changed elsewhere`). */
export class TaskError extends BacklogError {
	readonly task?: BacklogTask;
	constructor(message: string, task?: BacklogTask) {
		super(message);
		this.task = task;
	}
}

/** One task by ref or number; undefined when no task has that number. */
export function getTask(db: Db, repo: string, ref: string | number): BacklogTask | undefined {
	const seq = typeof ref === "number" ? ref : parseTaskRef(ref);
	const row = seq === undefined ? undefined : tasks.taskBySeq(db, repo, seq);
	return row ? toTask(row) : undefined;
}

/** The task `ref` names, or a refusal saying there is none. */
export function requireTask(db: Db, repo: string, ref: string): BacklogTask {
	const task = getTask(db, repo, ref);
	if (!task) throw new TaskError(`No task ${ref}.`);
	return task;
}

/** Tasks matching `query`: an item's, a session's or the whole repository's; each owner's in position order. */
export function listTasks(db: Db, repo: string, query: ListTasksQuery = {}): BacklogTask[] {
	if (query.item !== undefined && query.session !== undefined)
		throw new TaskError("List the tasks of an item or of a session, not both.");
	const item = query.item === undefined ? undefined : getItem(db, repo, query.item);
	if (query.item !== undefined && !item) throw new BacklogError(`No backlog item ${query.item}.`);
	return tasks
		.listTasks(db, {
			repo,
			...(item ? { itemId: item.rowId } : {}),
			...(query.session !== undefined ? { sessionId: query.session } : {}),
			...(query.states ? { states: query.states } : {}),
		})
		.map(toTask);
}

/** Task counts by owner: `items` by item ref (`B12`), `sessions` by session id, `total` for the repository. */
export interface TaskCounts {
	items: Record<string, TaskTally>;
	sessions: Record<string, TaskTally>;
	total: TaskTally;
}

const emptyTally = (): TaskTally => Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as TaskTally;

export function taskCounts(db: Db, repo: string): TaskCounts {
	const counts: TaskCounts = { items: {}, sessions: {}, total: emptyTally() };
	for (const row of tasks.taskCounts(db, repo)) {
		const state = row.state as TaskState;
		const bucket = row.item_seq === null ? counts.sessions : counts.items;
		const key = row.item_seq === null ? (row.session_id ?? "") : `B${row.item_seq}`;
		(bucket[key] ??= emptyTally())[state] += row.n;
		counts.total[state] += row.n;
	}
	return counts;
}
