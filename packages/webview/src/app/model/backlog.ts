import type { Snapshot, SnapshotItem, State } from "@octocodeai/octocode-contacts/snapshot";
import { median } from "./format.ts";

export type Item = SnapshotItem;
export const PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export const ITEM_TYPES = ["task", "epic", "bug", "research"] as const;
export const STATE_TITLES: Record<State, string> = {
	backlog: "Backlog",
	todo: "To do",
	ongoing: "In progress",
	done: "Done",
};
export const PRIORITY_TITLES: Record<string, string> = { p0: "Urgent", p1: "High", p2: "Medium", p3: "Low" };

export interface BacklogIndex {
	repo: string;
	now: number;
	idleMs: number;
	states: readonly State[];
	items: readonly Item[];
	byRef: ReadonlyMap<string, Item>;
}

export function indexBacklog(snapshot: Snapshot): BacklogIndex {
	return {
		repo: snapshot.repo,
		now: snapshot.generatedAt,
		idleMs: snapshot.idleMs,
		states: snapshot.states,
		items: snapshot.items,
		byRef: new Map(snapshot.items.map((it) => [it.ref, it])),
	};
}

export function isStale(it: Item): boolean {
	return it.state === "ongoing" && !it.assigneeLive;
}
function isIdle(index: BacklogIndex, it: Item): boolean {
	return it.state !== "done" && index.now - it.updatedAt > index.idleMs;
}
export function cycleTime(it: Item): number | undefined {
	return it.startedAt && it.doneAt && it.doneAt >= it.startedAt ? it.doneAt - it.startedAt : undefined;
}
function sequence(it: Item): number {
	return Number(it.ref.slice(1));
}

const haystacks = new WeakMap<Item, string>();
/** Every searchable field and note, lower-cased once per item object. */
function haystack(it: Item): string {
	let text = haystacks.get(it);
	if (text === undefined) {
		text = [
			it.ref,
			it.type ?? "task",
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
		]
			.join("\n")
			.toLowerCase();
		haystacks.set(it, text);
	}
	return text;
}
function matchesQuery(it: Item, q = ""): boolean {
	const needle = q.trim().toLowerCase();
	return !needle || haystack(it).includes(needle);
}

interface BoardFilters {
	q?: string;
	p?: string;
	type?: string;
	ready?: string;
}
export function filterBoard(index: BacklogIndex, filters: BoardFilters): Item[] {
	return index.items.filter(
		(it) =>
			matchesQuery(it, filters.q) &&
			(!filters.p || it.priority === filters.p) &&
			(!filters.type || (it.type ?? "task") === filters.type) &&
			(!filters.ready || (it.state === "todo" && !it.blockedBy?.length)),
	);
}

export interface TableColumn {
	key: string;
	label: string;
	first: "asc" | "desc";
	value: (it: Item, index: BacklogIndex) => string | number;
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
export function filterTable(index: BacklogIndex, filters: TableFilters): Item[] {
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

export function distinct(items: readonly Item[], pick: (it: Item) => readonly string[]): string[] {
	return [...new Set(items.flatMap(pick))].sort();
}

export interface TreeNode {
	item: Item;
	children: TreeNode[];
}
/** Parent/child links may contain cycles in imported data; each branch visits an item at most once. */
export function buildTree(index: BacklogIndex): { roots: TreeNode[]; alone: Item[] } {
	function node(it: Item, seen: ReadonlySet<string>): TreeNode {
		const inner = new Set(seen).add(it.ref);
		const children = (it.children ?? [])
			.filter((ref) => index.byRef.has(ref) && !seen.has(ref) && ref !== it.ref)
			.map((ref) => node(index.byRef.get(ref)!, inner));
		return { item: it, children };
	}
	const roots = index.items.filter((it) => !it.parentId);
	return {
		roots: roots.filter((it) => it.children?.length).map((it) => node(it, new Set())),
		alone: roots.filter((it) => !it.children?.length),
	};
}
export function attention(index: BacklogIndex): { claims: Item[]; idle: Item[] } {
	return {
		claims: index.items.filter(isStale),
		idle: index.items.filter((it) => isIdle(index, it)).sort((a, b) => a.updatedAt - b.updatedAt),
	};
}

/** The `from` ancestry, oldest first, stopping at a missing item or a cycle. */
export function originChain(index: BacklogIndex, it: Item): string[] {
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
