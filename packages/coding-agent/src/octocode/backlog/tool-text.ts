import type { Item } from "./store.ts";
import { plural } from "../shared/render/text.ts";

export interface BacklogToolDetails {
	item?: Item;
	/** list: items shown and matched. */
	shown?: number;
	total?: number;
	/** remove: the removed item's ref. */
	removed?: string;
}

/** The `⎿` line: `B12 → done`, `Added B3`, `Removed B1`, `3 items`. */
export function backlogSummary(op: unknown, details: BacklogToolDetails, text: string): string {
	const item = details.item;
	if (op === "list" && details.total !== undefined)
		return details.total === 0
			? "No items"
			: details.total > (details.shown ?? 0)
				? `${details.shown} of ${plural(details.total, "item")}`
				: plural(details.total, "item");
	if (op === "remove" && details.removed) return `Removed ${details.removed}`;
	if (item && op === "add") return `Added ${item.ref} · ${item.state}`;
	if (item && op === "update") return `${item.ref} → ${item.state}`;
	if (item) return `${item.ref} · ${item.state} · ${item.title}`;
	return text.split("\n", 1)[0] ?? "";
}

/**
 * What the model reads about `backlog`: the description says what it is, `op` owns the operations, the guidelines only
 * when to use it. The write rules (who may change what) live in `writes.ts`; this tool checks the shape of a call. Which
 * work is an item is stated here; the quick-work threshold for steps is in `steps`'s guidelines (`task-tool.ts`).
 */
export function backlogPrompt(subagent: boolean): {
	promptSnippet: string;
	description: string;
	ops: string;
	promptGuidelines: string[];
} {
	const description =
		// The same text for every role, so parent and child declare identical bytes; a role's limits are stated when it hits them.
		"Repository work items by state: backlog proposed, todo accepted, ongoing claimed, done completed. " +
		"An item another running session holds takes only notes. " +
		"Claiming (ongoing) needs why and goal; done needs completion.";
	const ops =
		"list/get: read (list: all filters apply); follow Next for more. " +
		(subagent
			? "add: propose; update: ongoing/done or notes"
			: "add: propose; update: edit, claim (ongoing) or add notes; remove: only duplicates or user-requested items without history");
	return {
		// The snippet says when to use the tool for every role; the description and `op` say how.
		promptSnippet:
			"Work that outlives the session, needs another person, records a follow-up or failure, or was requested",
		description,
		ops,
		promptGuidelines: subagent
			? [
					"If your task names a backlog item, note progress on it and close it after verifying its goal. Propose, never do, follow-ups and unfixed failures (trigger, evidence, fix) with from and links.",
				]
			: [
					"The steps of one piece of work go in `steps` under the claimed item, not in separate items.",
					"Claim the item before starting or delegating work it covers; update touched items before reporting. Every item needs why, paths, links (a follow-up: from, trigger, evidence, fix).",
				],
	};
}
