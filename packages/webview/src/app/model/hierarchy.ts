import { type BacklogTask, TASK_STATES, type TaskState, type TaskTally } from "@octocodeai/octocode-contracts/backlogs";
import type { SnapshotItem, State } from "@octocodeai/octocode-contracts/snapshot";
import type { BacklogIndex } from "./backlog.ts";

export const TASK_STATE_TITLES: Record<TaskState, string> = {
	todo: "To do",
	ongoing: "In progress",
	done: "Done",
	dropped: "Dropped",
};

export const isEpic = (item: SnapshotItem): boolean => item.type === "epic";

/** What the page shows for an item's state: an epic's is derived from its items. */
export const shownState = (item: SnapshotItem): State => (isEpic(item) ? (item.epicState ?? item.state) : item.state);

function tally(tasks: readonly BacklogTask[] | undefined): TaskTally {
	const counts = Object.fromEntries(TASK_STATES.map((state) => [state, 0])) as TaskTally;
	for (const task of tasks ?? []) counts[task.state]++;
	return counts;
}

const openTasks = (counts: TaskTally): number => counts.todo + counts.ongoing;

/** The items an epic holds, in the order the snapshot lists them. */
function childItems(index: BacklogIndex, epic: SnapshotItem): SnapshotItem[] {
	const refs = new Set(epic.children ?? []);
	for (const item of index.items) if (item.parentId === epic.ref) refs.add(item.ref);
	return [...refs].flatMap((ref) => index.byRef.get(ref) ?? []);
}

export interface Rollup {
	items: number;
	itemsDone: number;
	byState: Record<State, number>;
	tasks: TaskTally;
}

/** The counts an epic shows: its items by state and the tasks under them. */
export function rollup(index: BacklogIndex, epic: SnapshotItem): Rollup {
	const children = childItems(index, epic);
	const byState = Object.fromEntries(index.states.map((state) => [state, 0])) as Record<State, number>;
	for (const child of children) byState[child.state] = (byState[child.state] ?? 0) + 1;
	return {
		items: children.length,
		itemsDone: byState.done ?? 0,
		byState,
		tasks: tally(children.flatMap((child) => child.tasks ?? [])),
	};
}

/** A one-line roll-up such as "2 of 5 items done · 3 tasks open"; empty when the epic holds nothing yet. */
export function rollupText(value: Rollup): string {
	const parts: string[] = [];
	if (value.items) parts.push(`${value.itemsDone} of ${value.items} ${value.items === 1 ? "item" : "items"} done`);
	const open = openTasks(value.tasks);
	if (open) parts.push(`${open} ${open === 1 ? "task" : "tasks"} open`);
	return parts.join(" · ");
}

/** A one-line task tally such as "1 of 3 tasks done"; empty when there are none. */
export function taskTallyText(tasks: readonly BacklogTask[] | undefined): string {
	if (!tasks?.length) return "";
	const done = tasks.filter((task) => task.state === "done").length;
	return `${done} of ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} done`;
}

/** The epics an item may nest under: any epic except the item itself; an epic has no parent. */
export function epicsFor(index: BacklogIndex, item: SnapshotItem): SnapshotItem[] {
	return isEpic(item) ? [] : index.items.filter((entry) => isEpic(entry) && entry.ref !== item.ref);
}

/** The position a task takes after moving `delta` places within its owner's list; undefined at the end of the list. */
export function movedPosition(siblings: readonly BacklogTask[], ref: string, delta: -1 | 1): number | undefined {
	const at = siblings.findIndex((task) => task.ref === ref);
	const to = at + delta;
	return at < 0 || to < 0 || to >= siblings.length ? undefined : to;
}

export interface SessionTaskGroup {
	session: string;
	tasks: BacklogTask[];
}

/** Session tasks grouped by session, in the order the snapshot lists them. */
export function sessionGroups(tasks: readonly BacklogTask[]): SessionTaskGroup[] {
	const groups = new Map<string, BacklogTask[]>();
	for (const task of tasks) {
		if (task.owner.kind !== "session") continue;
		groups.set(task.owner.id, [...(groups.get(task.owner.id) ?? []), task]);
	}
	return [...groups].map(([session, entries]) => ({ session, tasks: entries }));
}
