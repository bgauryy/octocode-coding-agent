import {
	type BacklogTask,
	DEFAULT_ITEM_TYPE,
	PRIORITIES,
	looksLikePath,
	matchPaths,
} from "@octocodeai/octocode-contracts/backlogs";
import type { Snapshot, SnapshotItem, State } from "@octocodeai/octocode-contracts/snapshot";
import { median } from "./format.ts";

export const STATE_TITLES: Record<State, string> = {
	backlog: "Backlog",
	todo: "To do",
	ongoing: "In progress",
	done: "Done",
};
export const PRIORITY_TITLES: Record<string, string> = { p0: "Urgent", p1: "High", p2: "Medium", p3: "Low" };
/** Priority choices for selects, labelled with the priority and its title. */
export const PRIORITY_OPTIONS = PRIORITIES.map((value) => ({ value, label: `${value} · ${PRIORITY_TITLES[value]}` }));

export interface BacklogIndex {
	repo: string;
	now: number;
	idleMs: number;
	states: readonly State[];
	items: readonly SnapshotItem[];
	byRef: ReadonlyMap<string, SnapshotItem>;
	/** Tasks that belong to a session and no item. */
	sessionTasks: readonly BacklogTask[];
}

export function indexBacklog(snapshot: Snapshot): BacklogIndex {
	return {
		repo: snapshot.repo,
		now: snapshot.generatedAt,
		idleMs: snapshot.idleMs,
		states: snapshot.states,
		items: snapshot.items,
		byRef: new Map(snapshot.items.map((it) => [it.ref, it])),
		sessionTasks: snapshot.sessionTasks ?? [],
	};
}

export function isStale(it: SnapshotItem): boolean {
	return it.state === "ongoing" && !it.assigneeLive;
}
export function isReadyToStart(it: SnapshotItem): boolean {
	return it.state === "todo" && !it.blockedBy?.length && Boolean(it.goal.trim() && it.why.trim());
}
function isIdle(index: BacklogIndex, it: SnapshotItem): boolean {
	return it.state !== "done" && index.now - it.updatedAt > index.idleMs;
}
export function cycleTime(it: SnapshotItem): number | undefined {
	return it.startedAt !== undefined && it.doneAt !== undefined && it.doneAt >= it.startedAt
		? it.doneAt - it.startedAt
		: undefined;
}
/** Ranked items first, ascending; two unranked items tie. */
function compareRank(a: SnapshotItem, b: SnapshotItem): number {
	if (a.rank === undefined || b.rank === undefined) return Number(a.rank === undefined) - Number(b.rank === undefined);
	return a.rank - b.rank;
}

function sequence(it: SnapshotItem): number {
	return Number(it.ref.slice(1));
}

const haystacks = new WeakMap<SnapshotItem, string>();
/** Every searchable field and note, lower-cased once per item object. */
function haystack(it: SnapshotItem): string {
	let text = haystacks.get(it);
	if (text === undefined) {
		text = [
			it.ref,
			it.type ?? DEFAULT_ITEM_TYPE,
			it.parentId ?? "",
			JSON.stringify(it.completions ?? []),
			JSON.stringify(it.links ?? []),
			it.title,
			it.goal,
			it.body,
			it.why,
			it.plan,
			it.state,
			it.priority,
			it.assignee ?? "",
			it.createdBy,
			it.paths.join(" "),
			it.evidence.join(" "),
			it.tags.join(" "),
			...it.notes.map((note) => `${note.author} ${note.text}`),
			...(it.comments ?? []).map((comment) => `${comment.author} ${comment.text}`),
			...(it.tasks ?? []).map(
				(task) => `${task.ref} ${task.goal} ${task.reason} ${task.result} ${task.state} ${task.assignee ?? ""}`,
			),
		]
			.join("\n")
			.toLowerCase();
		haystacks.set(it, text);
	}
	return text;
}
function matchesQuery(it: SnapshotItem, q = ""): boolean {
	const needle = q.trim().toLowerCase();
	// A path (`packages/db/src/`, `./a.ts:12`) also finds items naming a folder that holds it, or files under it.
	return !needle || haystack(it).includes(needle) || (looksLikePath(needle) && matchPaths(it, [q]) !== undefined);
}

interface BoardFilters {
	q?: string;
	p?: string;
	type?: string;
	ready?: string;
	tag?: string;
	assignee?: string;
	sort?: string;
	/** `show`: closed items stay on the board, in their own column; they are hidden by default. */
	closed?: string;
}
export function filterBoard(index: BacklogIndex, filters: BoardFilters): SnapshotItem[] {
	return index.items
		.filter(
			(it) =>
				(filters.closed === "show" || !it.closed) &&
				matchesQuery(it, filters.q) &&
				(!filters.p || it.priority === filters.p) &&
				(!filters.type || (it.type ?? DEFAULT_ITEM_TYPE) === filters.type) &&
				(!filters.tag || it.tags.includes(filters.tag)) &&
				(!filters.assignee || it.assignee === filters.assignee) &&
				(!filters.ready || isReadyToStart(it)),
		)
		.sort((a, b) => {
			// A hand-ordered card comes before one that was never ordered; the "updated" sort ignores the manual order.
			const manual = filters.sort === "updated" ? 0 : compareRank(a, b);
			const order = filters.sort === "updated" ? b.updatedAt - a.updatedAt : a.priority.localeCompare(b.priority);
			return manual || order || sequence(a) - sequence(b);
		});
}

export interface TableColumn {
	key: string;
	label: string;
	first: "asc" | "desc";
	value: (it: SnapshotItem, index: BacklogIndex) => string | number;
	numeric?: boolean;
}
export const TABLE_COLUMNS: readonly TableColumn[] = [
	{ key: "ref", label: "ID", first: "asc", value: sequence },
	{ key: "state", label: "Status", first: "asc", value: (it, index) => index.states.indexOf(it.state) },
	{ key: "priority", label: "Priority", first: "asc", value: (it) => PRIORITIES.indexOf(it.priority as never) },
	{ key: "title", label: "Title", first: "asc", value: (it) => it.title.toLowerCase() },
	{ key: "assignee", label: "Assignee", first: "asc", value: (it) => (it.assignee ?? "").toLowerCase() },
	{ key: "tags", label: "Tags", first: "asc", value: (it) => it.tags.join(" ") },
	{ key: "updated", label: "Updated", first: "desc", value: (it) => it.updatedAt },
	{ key: "created", label: "Created", first: "desc", value: (it) => it.createdAt },
	{ key: "notes", label: "Notes", first: "desc", value: (it) => it.notes.length, numeric: true },
	{ key: "derived", label: "Derived", first: "desc", value: (it) => it.derived.length, numeric: true },
];
export const DEFAULT_SORT = { sort: "updated", dir: "desc" } as const;

interface TableFilters {
	q?: string;
	state?: string;
	p?: string;
	tag?: string;
	assignee?: string;
	sort?: string;
	dir?: string;
}
export function filterTable(index: BacklogIndex, filters: TableFilters): SnapshotItem[] {
	const column = TABLE_COLUMNS.find((c) => c.key === filters.sort) ?? TABLE_COLUMNS[6];
	const direction = (filters.dir ?? column.first) === "asc" ? 1 : -1;
	return index.items
		.filter(
			(it) =>
				(!filters.state || it.state === filters.state) &&
				(!filters.p || it.priority === filters.p) &&
				(!filters.tag || it.tags.includes(filters.tag)) &&
				(!filters.assignee || it.assignee === filters.assignee) &&
				matchesQuery(it, filters.q),
		)
		.sort((a, b) => {
			const x = column.value(a, index);
			const y = column.value(b, index);
			const order = x < y ? -1 : x > y ? 1 : 0;
			return order * direction || sequence(a) - sequence(b);
		});
}

export function distinct(items: readonly SnapshotItem[], pick: (it: SnapshotItem) => readonly string[]): string[] {
	return [...new Set(items.flatMap(pick))].sort();
}

export interface TreeNode {
	item: SnapshotItem;
	children: TreeNode[];
}
/** Build a complete forest even if an imported parent is missing or a disconnected component contains a cycle. */
export function buildTree(index: BacklogIndex): { roots: TreeNode[]; alone: SnapshotItem[] } {
	const children = new Map(index.items.map((item) => [item.ref, new Set(item.children)]));
	for (const item of index.items) {
		if (item.parentId) children.get(item.parentId)?.add(item.ref);
	}
	const visited = new Set<string>();
	function node(item: SnapshotItem): TreeNode {
		visited.add(item.ref);
		const branches: TreeNode[] = [];
		for (const ref of children.get(item.ref) ?? []) {
			const child = index.byRef.get(ref);
			if (child && !visited.has(ref)) branches.push(node(child));
		}
		return { item, children: branches };
	}
	const forest: TreeNode[] = [];
	const candidates = [
		...index.items.filter((item) => !item.parentId || !index.byRef.has(item.parentId)),
		...index.items,
	];
	for (const item of candidates) if (!visited.has(item.ref)) forest.push(node(item));
	return {
		// An epic is a root even while empty, so an item can be put under it.
		roots: forest.filter((entry) => entry.children.length || entry.item.type === "epic"),
		alone: forest.filter((entry) => !entry.children.length && entry.item.type !== "epic").map((entry) => entry.item),
	};
}
export function attention(index: BacklogIndex): { claims: SnapshotItem[]; idle: SnapshotItem[] } {
	return {
		claims: index.items.filter(isStale),
		idle: index.items.filter((it) => isIdle(index, it)).sort((a, b) => a.updatedAt - b.updatedAt),
	};
}

/** The `from` ancestry, oldest first, stopping at a missing item or a cycle. */
export function originChain(index: BacklogIndex, it: SnapshotItem): string[] {
	const refs: string[] = [];
	const seen = new Set<string>();
	for (let at = it.from; at && index.byRef.has(at) && !seen.has(at); at = index.byRef.get(at)?.from) {
		seen.add(at);
		refs.unshift(at);
	}
	return refs;
}
export function blocks(index: BacklogIndex, ref: string): string[] {
	return index.items.filter((other) => other.dependsOn?.some((dep) => dep.id === ref)).map((other) => other.ref);
}

interface BacklogStats {
	total: number;
	byState: Record<State, number>;
	byPriority: Record<string, number>;
	medianCycle: number | undefined;
	cycles: number;
	attention: number;
}
export function backlogStats(index: BacklogIndex): BacklogStats {
	const byState = Object.fromEntries(index.states.map((state) => [state, 0])) as Record<State, number>;
	const byPriority: Record<string, number> = Object.fromEntries(PRIORITIES.map((p) => [p, 0]));
	for (const it of index.items) {
		byState[it.state] = (byState[it.state] ?? 0) + 1;
		byPriority[it.priority] = (byPriority[it.priority] ?? 0) + 1;
	}
	const cycles = index.items.map(cycleTime).filter((value): value is number => value !== undefined);
	return {
		total: index.items.length,
		byState,
		byPriority,
		medianCycle: median(cycles),
		cycles: cycles.length,
		attention: index.items.filter((it) => isStale(it) || isIdle(index, it)).length,
	};
}
