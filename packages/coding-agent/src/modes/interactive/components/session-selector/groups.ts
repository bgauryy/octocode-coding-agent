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

/** One list item: a session node, and the group label drawn above it when it starts a group. */
export interface SessionRow {
	node: FlatSessionNode;
	label?: string;
}

/** The nodes as list items, each carrying the label that starts its group. */
export function sessionRows(grouped: GroupedNodes): SessionRow[] {
	return grouped.nodes.map((node, index) => {
		const label = grouped.labels.get(index);
		return label === undefined ? { node } : { node, label };
	});
}
