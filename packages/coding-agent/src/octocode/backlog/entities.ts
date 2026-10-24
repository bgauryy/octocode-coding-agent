import type { DatabaseSync } from "node:sqlite";
import type { BacklogRef, Completion, EntityInput, ItemType, WorkLink } from "@octocodeai/octocode-contacts/backlogs";
import type { State } from "@octocodeai/octocode-contacts/snapshot";
import { refText, type toItem } from "./row.ts";
import type { Item } from "./item.ts";

/** Fields owned by the item store rather than the shared entity contract. Unknown keys remain for validation. */
const ITEM_FIELDS = new Set([
	"note",
	"title",
	"goal",
	"body",
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
]);

export function entityInput(input: EntityInput): EntityInput {
	return Object.fromEntries(Object.entries(input).filter(([key]) => !ITEM_FIELDS.has(key)));
}

interface EntityRow {
	id: number;
	type: ItemType;
	parent_seq: number | null;
	links: string;
	completions: string;
}

/** Fetch the entity data for an entire page in one statement, preserving each relation's stored order. */
export function enrichItems(db: DatabaseSync, repo: string, bases: ReturnType<typeof toItem<State>>[]): Item[] {
	if (!bases.length) return [];
	const rows = db
		.prepare(`
		SELECT b.id, b.type, p.seq AS parent_seq,
			(SELECT json_group_array(json_object('relation', relation, 'target', target)) FROM
				(SELECT relation, target FROM backlog_links WHERE item = b.id ORDER BY rowid)) AS links,
			(SELECT json_group_array(json_object('id', id, 'payload', payload)) FROM
				(SELECT id, payload FROM backlog_completions WHERE item = b.id ORDER BY id)) AS completions
		FROM backlog b LEFT JOIN backlog p ON p.id = b.parent_id AND p.repo_key = ?
		WHERE b.id IN (SELECT value FROM json_each(?))
	`)
		.all(repo, JSON.stringify(bases.map((base) => base.rowId))) as unknown as EntityRow[];
	const byId = new Map(rows.map((row) => [row.id, row]));
	return bases.map((base) => {
		const row = byId.get(base.rowId);
		if (!row) throw new Error(`Backlog item ${base.ref} disappeared while reading its entities.`);
		const links = JSON.parse(row.links) as { relation: string; target: string }[];
		const completions = JSON.parse(row.completions) as { id: number; payload: string }[];
		return {
			...base,
			reason: base.why,
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
