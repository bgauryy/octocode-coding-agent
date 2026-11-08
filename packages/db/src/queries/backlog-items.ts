import type { DatabaseSync } from "node:sqlite";
import { allRows, num } from "../rows.ts";

/** A persisted item, including the joined sequence number of its origin. */
export interface ItemRow<State extends string> {
	id: number;
	seq: number;
	title: string;
	goal: string;
	body: string;
	paths: string;
	why: string;
	evidence: string;
	plan: string;
	state: State;
	priority: number;
	/** Manual position in a column (ascending), or null until the item is first ordered by hand. */
	rank: number | null;
	tags: string;
	assignee: string | null;
	created_by: string;
	source_session: string | null;
	created_at: number;
	updated_at: number;
	started_at: number | null;
	done_at: number | null;
	from_item: number | null;
	from_seq: number | null;
	version: number;
	/** The JSON of a closed item, else null. */
	closed: string | null;
}

/** Items with the number of the item each came from; filters and order use the `b.` alias. */
const SELECT = "SELECT b.*, f.seq AS from_seq FROM backlog b LEFT JOIN backlog f ON f.id = b.from_item";

const BOARD_ORDER = `CASE b.state WHEN 'ongoing' THEN 0 WHEN 'todo' THEN 1 WHEN 'backlog' THEN 2 ELSE 3 END, b.rank IS NULL, b.rank, b.priority, b.updated_at DESC, b.seq DESC`;

/** How a listing is ordered: `board` (state, priority, most recently updated), or newest first by update or creation. */
export const ITEM_SORTS = ["board", "updated", "created"] as const;
export type ItemSort = (typeof ITEM_SORTS)[number];

const ORDERS: Record<ItemSort, string> = {
	board: BOARD_ORDER,
	updated: "b.updated_at DESC, b.seq DESC",
	created: "b.created_at DESC, b.seq DESC",
};

const SEARCHED = ["title", "goal", "body", "paths", "why", "evidence", "plan"] as const;

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/** A `depends_on` link of item `b` whose prerequisite is missing or not done (the board's `blockedBy`). */
const OPEN_PREREQUISITE = `EXISTS (SELECT 1 FROM backlog_links l WHERE l.item = b.id AND l.relation = 'depends_on' AND NOT EXISTS (SELECT 1 FROM backlog d WHERE d.workspace_id = b.workspace_id AND 'B' || d.seq = json_extract(l.target, '$.id') AND d.state = 'done'))`;

/**
 * Which items a listing matches; every set field must hold. `states` is never empty; `text` is a trimmed, non-empty
 * search; a list field matches when any of its entries does, and an empty list matches nothing.
 */
export interface ItemFilter {
	repo: string;
	states: readonly string[];
	text?: string;
	/** Row id of the item the matches came from. */
	fromItem?: number;
	/** Item numbers. */
	seqs?: readonly number[];
	/** Words that all appear in the title. */
	titleWords?: readonly string[];
	/** Row id of an item: the items under it, at any depth. */
	underItem?: number;
	/** Stored type names. */
	types?: readonly string[];
	/** Priorities up to this one (0 is the most urgent). */
	maxPriority?: number;
	/** Whole tags, without `#`. */
	tags?: readonly string[];
	/** Item refs (`B12`) a match depends on. */
	dependsOn?: readonly string[];
	/** true: a prerequisite is missing or not done; false: none is. */
	blocked?: boolean;
	/** Session ids holding the item. */
	assignees?: readonly string[];
	/** Epoch milliseconds: updated at or after. */
	updatedSince?: number;
	/** Epoch milliseconds: created at or after. */
	createdSince?: number;
}

const marks = (values: readonly unknown[]) => values.map(() => "?").join(", ");

/** `(a OR b …)` over one clause per value, or a false clause for no values. */
const anyOf = (values: readonly string[], clause: string) =>
	values.length ? `(${values.map(() => clause).join(" OR ")})` : "0";

/** The `WHERE` clause (aliased `b`) and its arguments for a filter. */
function whereOf(filter: ItemFilter): { clause: string; args: Array<string | number> } {
	// `closed` is `done` underneath with a close record, but a different state to list: `done` leaves it out.
	const stored = [...new Set(filter.states.filter((state) => state !== "done" && state !== "closed"))];
	const clauses = [
		...(stored.length ? [`b.state IN (${marks(stored)})`] : []),
		...(filter.states.includes("done") ? ["(b.state = 'done' AND b.closed IS NULL)"] : []),
		...(filter.states.includes("closed") ? ["(b.state = 'done' AND b.closed IS NOT NULL)"] : []),
	];
	const where = [`b.workspace_id = ?`, clauses.length ? `(${clauses.join(" OR ")})` : "0"];
	const args: Array<string | number> = [filter.repo, ...stored];
	const add = (clause: string, ...values: Array<string | number>) => {
		where.push(clause);
		args.push(...values);
	};
	const text = filter.text;
	if (text) {
		// Every text field matches any substring (so `backlog/store` finds a path); a tag matches only whole (`ui` is not found in `build`), with or without `#`.
		const like = `%${likeEscape(text)}%`;
		add(
			`(${SEARCHED.map((column) => `b.${column} LIKE ? ESCAPE '\\'`).join(" OR ")} OR (' ' || b.tags || ' ') LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM backlog_completions c WHERE c.item = b.id AND c.payload LIKE ? ESCAPE '\\'))`,
			...SEARCHED.map(() => like),
			`% ${likeEscape(text.replace(/^#+/, ""))} %`,
			like,
		);
	}
	if (filter.fromItem !== undefined) add("b.from_item = ?", filter.fromItem);
	if (filter.seqs) add(`b.seq IN (${marks(filter.seqs)})`, ...filter.seqs);
	for (const word of filter.titleWords ?? []) add("b.title LIKE ? ESCAPE '\\'", `%${likeEscape(word)}%`);
	if (filter.underItem !== undefined)
		// UNION (not UNION ALL) stops at a row already seen, so a parent loop an older build left cannot recurse forever.
		add(
			"b.id IN (WITH RECURSIVE under(id) AS (SELECT id FROM backlog WHERE parent_id = ? UNION SELECT c.id FROM backlog c JOIN under u ON c.parent_id = u.id) SELECT id FROM under)",
			filter.underItem,
		);
	if (filter.types) add(`b.type IN (${marks(filter.types)})`, ...filter.types);
	if (filter.maxPriority !== undefined) add("b.priority <= ?", filter.maxPriority);
	if (filter.tags)
		add(
			anyOf(filter.tags, "(' ' || b.tags || ' ') LIKE ? ESCAPE '\\'"),
			...filter.tags.map((tag) => `% ${likeEscape(tag)} %`),
		);
	if (filter.dependsOn)
		add(
			`EXISTS (SELECT 1 FROM backlog_links l WHERE l.item = b.id AND l.relation = 'depends_on' AND json_extract(l.target, '$.id') IN (${marks(filter.dependsOn)}))`,
			...filter.dependsOn,
		);
	if (filter.blocked !== undefined) add(filter.blocked ? OPEN_PREREQUISITE : `NOT ${OPEN_PREREQUISITE}`);
	if (filter.assignees) add(`b.assignee IN (${marks(filter.assignees)})`, ...filter.assignees);
	if (filter.updatedSince !== undefined) add("b.updated_at >= ?", filter.updatedSince);
	if (filter.createdSince !== undefined) add("b.created_at >= ?", filter.createdSince);
	return { clause: where.join(" AND "), args };
}

/** Whether an item has children (`parent_id` is row `rowId`) or an item of `repo` depends on it (`ref`, its `B<seq>`). */
export function hasDependants(db: DatabaseSync, repo: string, rowId: number, ref: string): boolean {
	return (
		db
			.prepare(
				`SELECT 1 FROM backlog WHERE parent_id = ?
				 UNION ALL SELECT 1 FROM backlog_links l JOIN backlog b ON b.id = l.item
				 WHERE l.relation = 'depends_on' AND json_extract(l.target, '$.id') = ? AND b.workspace_id = ? LIMIT 1`,
			)
			.get(rowId, ref, repo) !== undefined
	);
}

/** The numbers among `seqs` whose item in `repo` is done. */
export function doneSeqs(db: DatabaseSync, repo: string, seqs: readonly number[]): Set<number> {
	if (!seqs.length) return new Set();
	const rows = allRows<{ seq: number }>(
		db.prepare(
			"SELECT seq FROM backlog WHERE workspace_id = ? AND state = 'done' AND seq IN (SELECT value FROM json_each(?))",
		),
		repo,
		JSON.stringify(seqs),
	);
	return new Set(rows.map((row) => num(row.seq)));
}

/**
 * For each of the items `rowIds`, the numbers of the open (backlog, todo, ongoing) items of `repo` under it at any
 * depth, in board order; as the `underItem` filter, UNION stops at a row already seen, so a parent loop ends.
 */
export function openDescendants(db: DatabaseSync, repo: string, rowIds: readonly number[]): Map<number, number[]> {
	const below = new Map<number, number[]>();
	if (!rowIds.length) return below;
	const rows = allRows<{ root: number; seq: number }>(
		db.prepare(
			`WITH RECURSIVE under(root, id) AS (
				SELECT parent_id, id FROM backlog WHERE parent_id IN (SELECT value FROM json_each(?))
				UNION SELECT u.root, c.id FROM backlog c JOIN under u ON c.parent_id = u.id)
			 SELECT u.root, b.seq FROM under u JOIN backlog b ON b.id = u.id
			 WHERE b.workspace_id = ? AND b.state IN ('backlog', 'todo', 'ongoing') ORDER BY u.root, ${BOARD_ORDER}`,
		),
		JSON.stringify(rowIds),
		repo,
	);
	for (const { root, seq } of rows) (below.get(root) ?? below.set(root, []).get(root)!).push(num(seq));
	return below;
}

/** One item row by its number in the repository. */
export function itemBySeq(db: DatabaseSync, repo: string, seq: number): ItemRow<string> | undefined {
	return db.prepare(`${SELECT} WHERE b.workspace_id = ? AND b.seq = ?`).get(repo, seq) as ItemRow<string> | undefined;
}

/** The `depends_on` prerequisites (`B12`) of item `seq` that are missing or not done (a closed item counts as done), in link order. */
export function openPrerequisites(db: DatabaseSync, repo: string, seq: number): string[] {
	return allRows<{ ref: string }>(
		db.prepare(
			`SELECT json_extract(l.target, '$.id') AS ref FROM backlog b JOIN backlog_links l ON l.item = b.id AND l.relation = 'depends_on'
			 WHERE b.workspace_id = ? AND b.seq = ?
			 AND NOT EXISTS (SELECT 1 FROM backlog d WHERE d.workspace_id = b.workspace_id AND 'B' || d.seq = json_extract(l.target, '$.id') AND d.state = 'done')
			 ORDER BY l.rowid`,
		),
		repo,
		seq,
	).map((row) => row.ref);
}

/** The rows of the items that came from `rowId`, in board order. */
export function derivedFrom(db: DatabaseSync, rowId: number): ItemRow<string>[] {
	return allRows<ItemRow<string>>(db.prepare(`${SELECT} WHERE b.from_item = ? ORDER BY ${BOARD_ORDER}`), rowId);
}

/** How many items a filter matches, ignoring any limit. */
export function countItems(db: DatabaseSync, filter: ItemFilter): number {
	const { clause, args } = whereOf(filter);
	return num((db.prepare(`SELECT COUNT(*) AS n FROM backlog b WHERE ${clause}`).get(...args) as { n: number }).n);
}

/** Matching rows in `sort` order (board by default); a negative `limit` is every row. */
export function listItems(
	db: DatabaseSync,
	filter: ItemFilter,
	limit: number,
	offset: number,
	sort: ItemSort = "board",
): ItemRow<string>[] {
	const { clause, args } = whereOf(filter);
	return allRows<ItemRow<string>>(
		db.prepare(`${SELECT} WHERE ${clause} ORDER BY ${ORDERS[sort]} LIMIT ? OFFSET ?`),
		...args,
		limit,
		offset,
	);
}
