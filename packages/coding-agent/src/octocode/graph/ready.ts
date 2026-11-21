import type { ItemSnap, WorkGraph } from "./model.ts";
import { nodeId } from "./model.ts";

const OPEN = new Set(["backlog", "todo", "ongoing"]);
const MET = new Set(["done", "closed"]);

export interface ReadyItem {
	ref: string;
	priority: number;
	/** The open items that wait on this one, directly or through others. */
	unblocks: number;
}

/** The open items that depend on `ref`, directly or through others; epics follow their items and do not count. */
function unblockCount(graph: WorkGraph, byRef: ReadonlyMap<string, ItemSnap>, ref: string): number {
	const seen = new Set<string>([ref]);
	const queue = [ref];
	while (queue.length) {
		for (const edge of graph.into(nodeId("item", queue.shift() ?? ""), "depends")) {
			const next = edge.from.slice("item:".length);
			const item = byRef.get(next);
			if (seen.has(next) || !item || !OPEN.has(item.state) || item.type === "epic") continue;
			seen.add(next);
			queue.push(next);
		}
	}
	return seen.size - 1;
}

/**
 * The items that can start now: accepted (`todo`; a proposal waits for acceptance) and not held, every prerequisite done or closed, and no resource they need
 * held by another. Ordered by priority (0 first), then by how many open items each unblocks (the longest chain first),
 * then by age, oldest first.
 */
export function readyItems(graph: WorkGraph, items: readonly ItemSnap[]): ReadyItem[] {
	const byRef = new Map(items.map((item) => [item.ref, item]));
	return items
		.filter(
			(item) =>
				item.state === "todo" &&
				item.type !== "epic" &&
				item.holder === undefined &&
				graph
					.out(nodeId("item", item.ref), "depends")
					.every((edge) => MET.has(graph.node(edge.to)?.state ?? "missing")) &&
				graph.into(nodeId("item", item.ref), "blocks").length === 0,
		)
		.map((item) => ({ item, unblocks: unblockCount(graph, byRef, item.ref) }))
		.toSorted(
			(a, b) =>
				a.item.priority - b.item.priority ||
				b.unblocks - a.unblocks ||
				a.item.createdAt - b.item.createdAt ||
				a.item.ref.localeCompare(b.item.ref, "en", { numeric: true }),
		)
		.map(({ item, unblocks }) => ({ ref: item.ref, priority: item.priority, unblocks }));
}

/** The held resources (`full-run (B892)`), each with the item it serves or else its holder. */
export function busyPools(graph: WorkGraph): string[] {
	return graph.nodes
		.filter((node) => node.kind === "resource")
		.map((node) => {
			const item = graph.out(node.id, "serves")[0]?.to.slice("item:".length);
			const holder = graph.into(node.id, "holds").find((edge) => edge.from.startsWith("agent:"));
			const who = item ?? holder?.from.slice("agent:".length);
			return who === undefined ? node.ref : `${node.ref} (${who})`;
		});
}

/** `ready: B897 (p1, unblocks 2), B898 (p1); busy: full-run (B892)`, the first `limit` ready items; empty when none is ready. */
export function readyText(ready: readonly ReadyItem[], busy: readonly string[], limit = 5): string {
	if (ready.length === 0) return "";
	const shown = ready
		.slice(0, limit)
		.map((item) => `${item.ref} (p${item.priority}${item.unblocks ? `, unblocks ${item.unblocks}` : ""})`);
	const more = ready.length > limit ? `, +${ready.length - limit} more` : "";
	return `ready: ${shown.join(", ")}${more}${busy.length ? `; busy: ${busy.join(", ")}` : ""}`;
}
