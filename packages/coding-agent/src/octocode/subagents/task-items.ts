import type { ExtensionContext } from "../../core/features/index.ts";
import { openBacklog } from "../backlog/context.ts";
import { type Item, priorityName } from "../backlog/store.ts";
import { fenceUntrusted, PARENT_FENCE_NOTE } from "../shared/fence.ts";

/** Most ids one brief expands, and the bytes of item text it adds in all: a brief is not a place to dump the board. */
const MAX_ITEMS = 8;
const MAX_BYTES = 6000;
const FIELD_BYTES = 600;

const ID = /(?<![\w#/.:-])B(\d{1,9})(?![\w-])/g;

/** The backlog ids (`B12`) a task names, once each, in the order it names them. */
export function findItemIds(task: string): string[] {
	return [...new Set([...task.matchAll(ID)].map((match) => `B${match[1]}`))];
}

const clip = (text: string, max = FIELD_BYTES): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function itemBlock(item: Item): string {
	const lines = [`${item.ref} [${item.state}, ${priorityName(item.priority)}] ${item.title}`];
	if (item.goal) lines.push(`Goal: ${clip(item.goal)}`);
	if (item.why) lines.push(`Why: ${clip(item.why)}`);
	if (item.paths.length > 0) lines.push(`Paths: ${clip(item.paths.join(", "))}`);
	return fenceUntrusted(`Backlog item ${item.ref} (this workspace's board)`, lines.join("\n"), {
		note: PARENT_FENCE_NOTE,
	});
}

/**
 * The `## Backlog items` section for the ids a task names, read from the given board: a child without the backlog tool
 * cannot look them up, and a raw database read cannot tell workspaces apart. An id the board does not hold is named as
 * unknown; ids and bytes past the caps are named as left out. Empty when the task names no id.
 */
export function itemsSection(task: string, store: { get(ref: string): Item | undefined }): string {
	const ids = findItemIds(task);
	if (ids.length === 0) return "";
	const blocks: string[] = [];
	const unknown: string[] = [];
	const capped: string[] = [];
	let bytes = 0;
	for (const [index, id] of ids.entries()) {
		const item = store.get(id);
		if (!item) {
			unknown.push(id);
			continue;
		}
		const block = itemBlock(item);
		if (index >= MAX_ITEMS || bytes + block.length > MAX_BYTES) {
			capped.push(id);
			continue;
		}
		bytes += block.length;
		blocks.push(block);
	}
	const notes = [
		unknown.length > 0 ? `Not on this workspace's board: ${unknown.join(", ")}.` : "",
		capped.length > 0
			? `Left out to keep the brief short (${MAX_ITEMS} items, ${MAX_BYTES} bytes): ${capped.join(", ")}.`
			: "",
	].filter(Boolean);
	return ["## Backlog items", ...blocks, ...notes].join("\n\n");
}

/**
 * `referenced` plus the backlog item text a child's task needs when it names ids and is not given `item` (a child with
 * an item reads its own through the backlog tool). Read from the parent's workspace; the board is opened only when the
 * task names an id.
 */
export function withItems(
	referenced: string,
	params: { task: string; item?: string | undefined },
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
): string {
	if (params.item || findItemIds(params.task).length === 0) return referenced;
	const items = itemsSection(params.task, openBacklog(ctx, { isSubagent: false }).store);
	return [referenced, items].filter(Boolean).join("\n\n");
}
