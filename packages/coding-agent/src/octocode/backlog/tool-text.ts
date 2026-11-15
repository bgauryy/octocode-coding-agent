import { renderInstruction } from "../../core/prompt-template.ts";
import type { Item } from "./store.ts";
import { plural } from "../shared/text.ts";

export interface BacklogToolDetails {
	item?: Item;
	/** list: items shown and matched. */
	shown?: number;
	total?: number;
}

/** The operations that change one item; `update` is the name calls stored before the tool was split carry. */
const CHANGES = ["claim", "note", "done", "close", "edit", "update"];

/** The `⎿` line: `B12 → done · Title`, `Added B3 · todo · Title`, `3 items`. */
export function backlogSummary(op: unknown, details: BacklogToolDetails, text: string): string {
	const item = details.item;
	if (op === "list" && details.total !== undefined)
		return details.total === 0
			? "No items"
			: details.total > (details.shown ?? 0)
				? `${details.shown} of ${plural(details.total, "item")}`
				: plural(details.total, "item");
	if (item && op === "add") return `Added ${item.ref} · ${item.state} · ${item.title}`;
	if (item && CHANGES.includes(op as string))
		return `${item.ref} → ${item.closed ? "closed" : item.state} · ${item.title}`;
	if (item) return `${item.ref} · ${item.state} · ${item.title}`;
	return text.split("\n", 1)[0] ?? "";
}

/**
 * What the model reads about `backlog`: the description says what it is, `op` owns the operations, the guidelines only
 * when to use it. The write rules (who may change what) live in `writes.ts`; the tool checks the shape of a call. The
 * text is the same for every role, so parent and child declare identical bytes; a role's limits are stated when it
 * hits them.
 */
export function backlogPrompt(subagent: boolean): {
	promptSnippet: string;
	description: string;
	ops: string;
	promptGuidelines: string[];
} {
	return {
		promptSnippet: renderInstruction("tools/backlog/snippet.md"),
		description:
			"Work states: backlog proposed, todo accepted, ongoing claimed, done complete. Other live claims: notes only unless delegated. No deletion.",
		ops: "get: read, follow Next; claim: start; note: progress; step: finish step with result/check note; done: finish item; close: end unneeded item",
		promptGuidelines: renderInstruction("tools/backlog/guidelines.md", { subagent }).split("\n"),
	};
}

/**
 * What the model reads about `backlogPlan`: planning and triage, which a session does far less often than it works an
 * item. The description names the operations and the shape of an entry, because a deferred declaration
 * (`permission/native-deferral.ts`) carries it without the schema.
 */
export function backlogPlanPrompt(): {
	promptSnippet: string;
	description: string;
	ops: string;
	promptGuidelines: string[];
} {
	return {
		promptSnippet: renderInstruction("tools/backlog-plan/snippet.md"),
		description:
			"Plan work. add/edit write items: [{title, goal, why}] or [{id, priority}]. list filters by other fields. Work one item with backlog.",
		ops: "add: propose items; edit: change their fields; list: follow Next",
		promptGuidelines: renderInstruction("tools/backlog-plan/guidelines.md").split("\n"),
	};
}
