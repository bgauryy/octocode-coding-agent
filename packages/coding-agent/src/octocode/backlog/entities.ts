import {
	type BacklogRef,
	type Completion,
	type EntityInput,
	type WorkLink,
} from "@octocodeai/octocode-contracts/backlogs";
import type { State } from "@octocodeai/octocode-contracts/snapshot";
import { type Db, backlog } from "../../../../db/src/api.ts";
import { refText, type toItem } from "./row.ts";
import type { Item } from "./item.ts";

/** Fields owned by the item store rather than the shared entity contract. Unknown keys remain for validation. */
const ITEM_FIELDS = new Set([
	"note",
	"title",
	"goal",
	"paths",
	"why",
	"evidence",
	"plan",
	"state",
	"priority",
	"tags",
	"from",
	"createdBy",
	"sourceSession",
	"force",
	"close",
]);

export function entityInput(input: EntityInput): EntityInput {
	return Object.fromEntries(Object.entries(input).filter(([key]) => !ITEM_FIELDS.has(key)));
}

/** Fetch the entity data for an entire page in one statement, preserving each relation's stored order. */
export function enrichItems(db: Db, repo: string, bases: ReturnType<typeof toItem<State>>[]): Item[] {
	if (!bases.length) return [];
	const rows = backlog.entityRows(
		db,
		repo,
		bases.map((base) => base.rowId),
	);
	const byId = new Map(rows.map((row) => [row.id, row]));
	return bases.map((base) => {
		const row = byId.get(base.rowId);
		if (!row) throw new Error(`Backlog item ${base.ref} disappeared while reading its entities.`);
		const links = JSON.parse(row.links) as { relation: string; target: string }[];
		const completions = JSON.parse(row.completions) as { id: number; payload: string }[];
		return {
			...base,
			type: row.type,
			...(row.parent_seq === null ? {} : { parentId: refText(row.parent_seq) }),
			dependsOn: links
				.filter((link) => link.relation === "depends_on")
				.map((link) => JSON.parse(link.target) as BacklogRef),
			links: links
				.filter((link) => link.relation !== "depends_on")
				.map((link) => ({ relation: link.relation, target: JSON.parse(link.target) }) as WorkLink),
			completions: completions.map((entry) => ({ ...JSON.parse(entry.payload), id: entry.id }) as Completion),
		};
	});
}
