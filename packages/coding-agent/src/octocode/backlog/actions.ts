import { renderInstruction } from "../../core/prompt-template.ts";
import { visibleControls } from "../../../../common/src/sanitize.ts";
import { itemDetail } from "./format.ts";
import { type BacklogStore, COMPLETION_GUIDANCE, type Item } from "./store.ts";

/** Read authoritative, unpaginated context while the dispatch transaction holds the item's claim. */
const brief = (item: Item, store: BacklogStore) => {
	const comments = store.comments(item.ref);
	// Comment entities retain their identity; avoid repeating their mirrored legacy notes.
	const commentNotes = new Set(comments.map(({ at, author, text }) => JSON.stringify([at, author, text])));
	const notes = store
		.notes(item, -1)
		.filter((note) => note.kind === "change" || !commentNotes.has(JSON.stringify([note.at, note.author, note.text])));
	const origin = item.from === undefined ? undefined : store.get(item.from);
	const lines = [
		itemDetail(item, notes, notes.length, Date.now(), {
			version: true,
			...(origin ? { origin } : {}),
			derived: store.derived(item),
		}),
		`Comments (${comments.length}, oldest first):`,
		...comments.map(
			(comment) =>
				`- #${comment.id} ${new Date(comment.at).toISOString()} ${visibleControls(comment.author)}:\n  ${visibleControls(comment.text).replace(/\n/g, "\n  ")}`,
		),
	];
	if (item.links.length) lines.push(`Links: ${visibleControls(JSON.stringify(item.links))}`);
	if (item.completions.length) lines.push(`Completion history: ${visibleControls(JSON.stringify(item.completions))}`);
	return lines.join("\n\n");
};

const handoff = (item: Item, store: BacklogStore) => ({
	ref: item.ref,
	readFirst: renderInstruction("workflows/backlog/read-first.md", { ref: item.ref }),
	brief: brief(item, store),
	completion: renderInstruction("workflows/backlog/completion.md", {
		ref: item.ref,
		goal: Boolean(item.goal),
		guidance: COMPLETION_GUIDANCE,
	}),
});

/** The prompt that hands an item to the agent ("Do it now"). */
export function doItPrompt(item: Item, store: BacklogStore): string {
	return renderInstruction("workflows/backlog/do-it.md", handoff(item, store));
}

/** The prompt that asks the agent to hand an item to a subagent. */
export function delegatePrompt(item: Item, store: BacklogStore): string {
	return renderInstruction("workflows/backlog/delegate.md", handoff(item, store));
}
