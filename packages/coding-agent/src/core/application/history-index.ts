import type { ApplicationMessage, ApplicationTool } from "@octocodeai/octocode-contracts";
import { PersistentMap } from "./persistent-map.ts";

interface MessageIndex {
	values: ApplicationMessage[];
	positions: Map<string, number>;
}

interface ToolIndex {
	values: ApplicationTool[];
	byMessage: Map<string, number[]>;
	byCall: Map<string, number[]>;
	ordered: { order: number; position: number }[];
}

// Only immutable versions can reuse indexes. Weak keys release a version's index when its readers leave.
const messages = new WeakMap<PersistentMap<ApplicationMessage>, MessageIndex>();
const tools = new WeakMap<PersistentMap<ApplicationTool>, ToolIndex>();

export function historyMessagePage(
	map: ReadonlyMap<string, ApplicationMessage>,
	before: string | undefined,
	limit: number,
): { values: ApplicationMessage[]; endOrder: number; hasMore: boolean } {
	let index = map instanceof PersistentMap ? messages.get(map) : undefined;
	if (!index) {
		const values = [...map.values()];
		const positions = new Map<string, number>();
		for (let position = 0; position < values.length; position++)
			if (!positions.has(values[position].id)) positions.set(values[position].id, position);
		index = { values, positions };
		if (map instanceof PersistentMap) messages.set(map, index);
	}
	const end = before === undefined ? index.values.length : index.positions.get(before);
	if (end === undefined) throw new Error("History cursor is not in this session");
	const values = index.values.slice(Math.max(0, end - limit), end);
	return { values, endOrder: index.values[end]?.order ?? Number.POSITIVE_INFINITY, hasMore: end > values.length };
}

function add(map: Map<string, number[]>, key: string, position: number): void {
	const positions = map.get(key);
	if (positions) positions.push(position);
	else map.set(key, [position]);
}

function toolIndex(map: PersistentMap<ApplicationTool>): ToolIndex {
	const known = tools.get(map);
	if (known) return known;
	const index: ToolIndex = { values: [...map.values()], byMessage: new Map(), byCall: new Map(), ordered: [] };
	for (let position = 0; position < index.values.length; position++) {
		const tool = index.values[position];
		if (tool.messageId !== undefined) add(index.byMessage, tool.messageId, position);
		add(index.byCall, tool.toolCallId, position);
		const order = tool.order ?? -1;
		if (!Number.isNaN(order)) index.ordered.push({ order, position });
	}
	index.ordered.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.position - b.position));
	tools.set(map, index);
	return index;
}

function lowerBound(ordered: ToolIndex["ordered"], order: number): number {
	let low = 0;
	let high = ordered.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (ordered[middle].order < order) low = middle + 1;
		else high = middle;
	}
	return low;
}

/** Order-range tools plus both ownership relations, returned in original insertion order without duplicates. */
export function historyTools(
	map: ReadonlyMap<string, ApplicationTool>,
	page: readonly ApplicationMessage[],
	firstOrder: number,
	endOrder: number,
): ApplicationTool[] {
	if (!(map instanceof PersistentMap)) {
		const ids = new Set(page.map((message) => message.id));
		const calls = new Set(page.flatMap((message) => (message.toolCallId ? [message.toolCallId] : [])));
		return [...map.values()].filter(
			(tool) =>
				(tool.messageId !== undefined && ids.has(tool.messageId)) ||
				calls.has(tool.toolCallId) ||
				((tool.order ?? -1) >= firstOrder && (tool.order ?? -1) < endOrder),
		);
	}
	const index = toolIndex(map);
	const selected = new Set<number>();
	for (const message of page) {
		for (const position of index.byMessage.get(message.id) ?? []) selected.add(position);
		if (message.toolCallId) for (const position of index.byCall.get(message.toolCallId) ?? []) selected.add(position);
	}
	if (firstOrder < endOrder) {
		const end = lowerBound(index.ordered, endOrder);
		for (let at = lowerBound(index.ordered, firstOrder); at < end; at++) selected.add(index.ordered[at].position);
	}
	return [...selected].sort((a, b) => a - b).map((position) => index.values[position]);
}
