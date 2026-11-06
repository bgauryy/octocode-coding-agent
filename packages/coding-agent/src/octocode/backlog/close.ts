import { CLOSE_KINDS, type Closed } from "@octocodeai/octocode-contracts/backlogs";
import { type Db } from "../../../../db/src/api.ts";
import { storedText } from "../../../../common/src/sanitize.ts";
import { type Actor, BacklogError, type Item, refuseSecrets } from "./item.ts";
import { openTasksRefusal } from "./hierarchy.ts";
import { getItem } from "./reads.ts";
import type { UpdateInput } from "./inputs.ts";

/**
 * The record of closing `item`: an item ends as closed, not deleted, when it is obsolete, a duplicate of another item or
 * will not be done. Refused for an item already done or closed (reopen it first), with open steps, without a reason, or
 * for a duplicate that does not name another existing item.
 */
export function closeRecord(db: Db, repo: string, item: Item, input: UpdateInput, actor: Actor, at: number): Closed {
	const close = input.close!;
	if (!CLOSE_KINDS.includes(close.kind)) throw new BacklogError(`close kind is one of ${CLOSE_KINDS.join(", ")}.`);
	const text = storedText(close.text);
	if (!text) throw new BacklogError("close needs a reason: say in words why this item is not needed.");
	refuseSecrets({ close: text });
	if (item.state === "done")
		throw new BacklogError(
			`${item.ref} is ${item.closed ? "already closed" : "done"}: reopen it (with a note) before changing it.`,
		);
	if (input.state !== undefined) throw new BacklogError("close and state are separate changes: send one.");
	let of: string | undefined;
	if (close.kind === "duplicate") {
		const target = close.of ? getItem(db, repo, close.of) : undefined;
		if (!target)
			throw new BacklogError('A duplicate names the item it duplicates: of is an existing item, e.g. "B12".');
		if (target.ref === item.ref) throw new BacklogError(`${item.ref} cannot be a duplicate of itself.`);
		of = target.ref;
	} else if (close.of) throw new BacklogError("of names the original of a duplicate; leave it out for this kind.");
	const open = openTasksRefusal(db, repo, item);
	if (open) throw new BacklogError(open);
	return { kind: close.kind, text, ...(of ? { of } : {}), by: actor.id, at };
}
