import type { FlatSessionNode } from "./session-tree.ts";
import { DAY_MS, startOfDay } from "./utils.ts";

/** How a flat list is divided: by day, by folder (the All scope), or not at all (threads, search relevance). */
export type GroupMode = "date" | "folder" | "none";

export interface GroupedNodes {
	nodes: FlatSessionNode[];
	/** Label shown above the node at each index: a day bucket, or the folder path (the caller decorates it). */
	labels: Map<number, string>;
}

/** Local calendar buckets: today, yesterday, the last week, everything older. */
function dateGroup(date: Date, now: Date = new Date()): string {
	const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
	if (days <= 0) return "Today";
	if (days === 1) return "Yesterday";
	if (days < 7) return "This week";
	return "Older";
}

/**
 * Insert group labels. `date` keeps the order and labels each change of day bucket. `folder` gathers a folder's
 * sessions under one label, folders in order of their newest session.
 */
export function groupNodes(nodes: FlatSessionNode[], mode: GroupMode, now: Date = new Date()): GroupedNodes {
	const labels = new Map<number, string>();
	if (mode === "none") return { nodes, labels };
	if (mode === "date") {
		let last = "";
		nodes.forEach((node, index) => {
			const label = dateGroup(node.session.modified, now);
			if (label !== last) labels.set(index, label);
			last = label;
		});
		return { nodes, labels };
	}
	const byFolder = new Map<string, FlatSessionNode[]>();
	for (const node of nodes) {
		const group = byFolder.get(node.session.cwd);
		if (group) group.push(node);
		else byFolder.set(node.session.cwd, [node]);
	}
	const ordered: FlatSessionNode[] = [];
	for (const [cwd, group] of byFolder) {
		labels.set(ordered.length, cwd);
		ordered.push(...group);
	}
	return { nodes: ordered, labels };
}

/** A line of the list: a group label (one line) or a session (`rowHeight` lines). */
export type ListItem = { label: string } | { row: number };

const ROW_HEIGHT = 2;

export function listItems(count: number, labels: ReadonlyMap<number, string>): ListItem[] {
	const items: ListItem[] = [];
	for (let row = 0; row < count; row++) {
		const label = labels.get(row);
		if (label !== undefined) items.push({ label });
		items.push({ row });
	}
	return items;
}

const heightOf = (item: ListItem): number => ("row" in item ? ROW_HEIGHT : 1);

/**
 * The first item to draw so the selected row, with the label above it, fits in `height` lines. `top` is where the
 * last draw began: the window moves only as far as the selection needs.
 */
export function scrollTop(items: readonly ListItem[], top: number, selectedRow: number, height: number): number {
	const at = items.findIndex((item) => "row" in item && item.row === selectedRow);
	if (at < 0) return 0;
	const head = at > 0 && "label" in items[at - 1] ? at - 1 : at;
	let next = Math.min(top, head);
	let used = 0;
	for (let i = next; i <= at; i++) used += heightOf(items[i]);
	while (used > height && next < at) used -= heightOf(items[next++]);
	return next;
}

/** The items from `top` that fit in `height` lines. A label is never drawn last: its row would be cut. */
export function visibleItems(items: readonly ListItem[], top: number, height: number): ListItem[] {
	const shown: ListItem[] = [];
	let used = 0;
	for (let i = top; i < items.length; i++) {
		const item = items[i];
		const need = heightOf(item) + ("label" in item ? ROW_HEIGHT : 0);
		if (used + need > height) break;
		shown.push(item);
		used += heightOf(item);
	}
	return shown;
}
