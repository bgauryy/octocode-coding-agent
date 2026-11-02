import type { WorkLink } from "@octocodeai/octocode-contracts/backlogs";
import type { ExtensionContext } from "../../core/features/index.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { type Backlog, openBacklog } from "../backlog/context.ts";
import { mergeLinks } from "../backlog/evidence-links.ts";
import { BacklogError } from "../backlog/item.ts";
import { REF_PREFIX } from "./worktree-base.ts";

/**
 * What a backlog item says about an isolated child's saved result: an `output` link to its ref and a note that the
 * change is saved but not merged, later a note that `/agents merge` merged it. The ref is the durable link: the item
 * that names it is found again from the ref alone, with no other state kept.
 */

const refLink = (backlog: Backlog, ref: string): WorkLink => ({
	relation: "output",
	target: { resource: "files", repositoryKey: backlog.store.repo, path: ref },
});

/** Links `ref` on `item` (the links already there stay) with a note that it is saved but not merged. */
export function noteSavedRef(backlog: Backlog, item: string, ref: string): void {
	const current = backlog.store.get(item);
	if (!current) throw new BacklogError(`No backlog item ${item}.`);
	const id = ref.slice(REF_PREFIX.length);
	backlog.store.update(
		current.ref,
		{
			links: mergeLinks(current.links, [refLink(backlog, ref)]),
			note: `The isolated change is saved on ${ref}, not merged yet. Merge it with \`/agents merge ${id}\`.`,
		},
		backlog.actor,
	);
}

/** Notes the merge of `ref` on each item that links it; the refs of those items, as `B12`. */
function noteMergedRef(backlog: Backlog, ref: string, into: string): string[] {
	const link = refLink(backlog, ref);
	const linked = backlog.store
		.list()
		.items.filter((item) => item.links.some((each) => JSON.stringify(each.target) === JSON.stringify(link.target)));
	for (const item of linked)
		backlog.store.update(item.ref, { note: `The isolated change on ${ref} was merged into ${into}.` }, backlog.actor);
	return linked.map((item) => item.ref);
}

/** `/agents merge`'s footer: the items the merge was noted on, or why it could not be (never throws: the merge itself happened). */
export function noteMerge(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, ref: string, into: string): string {
	try {
		const items = noteMergedRef(openBacklog(ctx, { isSubagent: false }), ref, into);
		return items.length ? `\nNoted on ${items.join(", ")}.` : "";
	} catch (error) {
		return `\nCould not note the merge on its backlog item: ${errorMessage(error)}`;
	}
}
