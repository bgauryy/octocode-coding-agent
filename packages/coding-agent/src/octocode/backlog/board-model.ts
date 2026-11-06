import type { BacklogTask } from "@octocodeai/octocode-contracts/backlogs";
import { type State, deriveEpicState } from "@octocodeai/octocode-contracts/snapshot";
import { type BacklogCounts, openEpics, summarizeCounts } from "./counts.ts";
import { BOARD_ORDER, STATE_TITLE } from "./format.ts";
import type { ItemMarks } from "./marks.ts";
import type { Item } from "./store.ts";

/** What the board shows, read once when it opens or refreshes: every item and the open tasks (todo, ongoing) of the repository. */
export interface BoardData {
	items: Item[];
	tasks: BacklogTask[];
	/** This session's id: its own session tasks get a section. */
	session: string;
	/** What each item waits on or whose claim ended, by ref (`BacklogStore.marks`); items without an entry have none. */
	marks?: ReadonlyMap<string, ItemMarks>;
}

/** A line the user can select: an epic or item (`B12`) or a task (`T7`). */
export type BoardRow =
	| { kind: "item"; key: string; item: Item; shown: State; tasks: number; marks: ItemMarks }
	| { kind: "task"; key: string; task: BacklogTask };

type BoardEntry =
	| { kind: "heading"; title: string; note?: string; state?: State }
	| { kind: "empty" }
	| { kind: "row"; row: BoardRow }
	/** A line that explains the row above it (an epic's items) and cannot be selected. */
	| { kind: "context"; text: string; state?: State };

export interface BoardLayout {
	entries: BoardEntry[];
	/** The selectable rows, top to bottom. */
	rows: BoardRow[];
	/** The footer's counts (`summarizeCounts`): items per state, epics counted once by derived state, closed items apart. */
	counts: BacklogCounts;
}

const DONE_SHOWN = 5;
const EPIC_ITEMS_SHOWN = 8;

/** Items in board order: grouped by state, Done cut to the most recent few. */
export function boardRows(items: Item[]): Item[] {
	return BOARD_ORDER.flatMap((state) => {
		const group = items.filter((item) => item.state === state);
		return state === "done"
			? group.sort((a, b) => (b.doneAt ?? b.updatedAt) - (a.doneAt ?? a.updatedAt)).slice(0, DONE_SHOWN)
			: group;
	});
}

/** The items that belong to `epic`. */
export const epicItems = (epic: Item, items: readonly Item[]): Item[] =>
	items.filter((item) => item.parentId === epic.ref);

/** An epic's state as the board shows it: derived from its items; any other item's own. */
function shownState(item: Item, items: readonly Item[]): State {
	return item.type === "epic"
		? deriveEpicState(
				item.state,
				epicItems(item, items).map((child) => child.state),
			)
		: item.state;
}

/** The ref of the item whose tasks the board opens for the selected row: the item itself, or the owner of the selected task. */
function expandedItem(row: BoardRow | undefined): string | undefined {
	if (!row) return undefined;
	if (row.kind === "item") return row.item.type === "epic" ? undefined : row.item.ref;
	return row.task.owner.kind === "item" ? row.task.owner.ref : undefined;
}

/**
 * The board from its data: Epics (derived state, item counts; the selected epic lists its items), a section per state
 * for the other items (the selected item, or one of its tasks, lists its open tasks; the others show a count), then this
 * session's own tasks. Pure and in memory: the board calls it when the selection or the data changes, not per frame.
 */
export function boardLayout(data: BoardData, selectedKey?: string): BoardLayout {
	const { items, tasks, session, marks } = data;
	const byItem = new Map<string, BacklogTask[]>();
	for (const task of tasks)
		if (task.owner.kind === "item") byItem.set(task.owner.ref, [...(byItem.get(task.owner.ref) ?? []), task]);
	const own = tasks.filter((task) => task.owner.kind === "session" && task.owner.id === session);
	// Closed items are not done and stay off the board (the counts say how many); a closed child still resolves its epic.
	const plain = items.filter((item) => item.type !== "epic" && !item.closed);
	const epics = items.filter((item) => item.type === "epic" && !item.closed);

	const entries: BoardEntry[] = [];
	const rows: BoardRow[] = [];
	const row = (value: BoardRow) => {
		rows.push(value);
		entries.push({ kind: "row", row: value });
	};
	const itemRow = (item: Item): BoardRow => ({
		kind: "item",
		key: item.ref,
		item,
		shown: shownState(item, items),
		tasks: byItem.get(item.ref)?.length ?? 0,
		marks: marks?.get(item.ref) ?? {},
	});
	const taskRow = (task: BacklogTask): BoardRow => ({ kind: "task", key: task.ref, task });

	// The selection decides what opens, so find it among the rows a collapsed board would have.
	const selected = selectedKey
		? [...items.map(itemRow), ...tasks.map(taskRow)].find((candidate) => candidate.key === selectedKey)
		: undefined;
	const open = expandedItem(selected);

	const counts = summarizeCounts(
		items.map((item) => ({
			key: item.ref,
			type: item.type,
			state: item.state,
			closed: item.closed !== undefined,
			...(item.parentId ? { parent: item.parentId } : {}),
		})),
	);
	const shownEpics = epics.filter((epic) => shownState(epic, items) !== "done");
	if (epics.length > 0) {
		entries.push({ kind: "heading", title: `Epics (${openEpics(counts)})`, note: `${counts.epics.done} done` });
		if (shownEpics.length === 0) entries.push({ kind: "empty" });
		for (const epic of shownEpics) {
			row(itemRow(epic));
			if (selectedKey !== epic.ref) continue;
			const children = epicItems(epic, items);
			for (const child of children.slice(0, EPIC_ITEMS_SHOWN))
				entries.push({ kind: "context", text: `${child.ref} ${child.title}`, state: child.state });
			if (children.length > EPIC_ITEMS_SHOWN)
				entries.push({ kind: "context", text: `${children.length - EPIC_ITEMS_SHOWN} more items` });
			if (children.length === 0) entries.push({ kind: "context", text: "no items yet" });
		}
	}

	const listed = boardRows(plain);
	for (const state of BOARD_ORDER) {
		const group = listed.filter((item) => item.state === state);
		const total = counts.items[state];
		entries.push({
			kind: "heading",
			state,
			title: `${STATE_TITLE[state]} (${total})`,
			...(state === "done" && total > group.length ? { note: `latest ${group.length}` } : {}),
		});
		if (group.length === 0) entries.push({ kind: "empty" });
		for (const item of group) {
			row(itemRow(item));
			if (item.ref === open) for (const task of byItem.get(item.ref) ?? []) row(taskRow(task));
		}
	}

	if (own.length > 0) {
		entries.push({ kind: "heading", title: `Session steps (${own.length})`, note: "this session" });
		for (const task of own) row(taskRow(task));
	}
	return { entries, rows, counts };
}
