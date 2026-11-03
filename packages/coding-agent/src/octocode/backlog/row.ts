import type { ItemRow } from "../../../../db/src/api.ts";

/** A persisted item, including the joined sequence number of its origin. */
export type Row<State extends string> = ItemRow<State>;

/** An item's number as people write it (`B12`); `none` when it has none. */
export const refText = (seq: number | undefined) => (seq === undefined ? "none" : `B${seq}`);

/** A stored list (one entry per line) as entries. */
const lines = (text: string): string[] => (text ? text.split("\n") : []);

export const toItem = <State extends string>(row: Row<State>) => ({
	rowId: row.id,
	seq: row.seq,
	ref: refText(row.seq),
	title: row.title,
	goal: row.goal,
	body: row.body,
	paths: lines(row.paths),
	why: row.why,
	evidence: lines(row.evidence),
	plan: row.plan,
	state: row.state,
	priority: row.priority,
	tags: row.tags ? row.tags.split(" ") : [],
	...(row.assignee ? { assignee: row.assignee } : {}),
	createdBy: row.created_by,
	...(row.source_session ? { sourceSession: row.source_session } : {}),
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	...(row.started_at ? { startedAt: row.started_at } : {}),
	...(row.done_at ? { doneAt: row.done_at } : {}),
	...(row.from_seq ? { from: row.from_seq } : {}),
	version: row.version,
});
