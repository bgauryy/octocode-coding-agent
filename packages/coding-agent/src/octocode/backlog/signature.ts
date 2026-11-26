import type { Item } from "./item.ts";

/** The evidence entry that ties an item to an `archive` error signature, so `get` and `done` can show the error's rate. */
export const SIGNATURE_EVIDENCE = "error signature: ";

/** The error signatures `item` carries in its evidence. */
export const signaturesOf = (item: Pick<Item, "evidence">): string[] =>
	item.evidence
		.filter((entry) => entry.startsWith(SIGNATURE_EVIDENCE))
		.map((entry) => entry.slice(SIGNATURE_EVIDENCE.length).trim())
		.filter(Boolean);
