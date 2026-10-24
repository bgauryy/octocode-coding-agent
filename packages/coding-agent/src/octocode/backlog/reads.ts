import type { DatabaseSync } from "node:sqlite";
import {
	STATES,
	type State,
	type Note,
	type BacklogComment,
	type BacklogAudit,
} from "@octocodeai/octocode-contacts/snapshot";
import { sessionRunningPid } from "../agentdb/liveness.ts";
import { redactData, visibleControls } from "../shared/sanitize.ts";
import { type Row, toItem } from "./row.ts";
import { enrichItems } from "./entities.ts";
import { type Item, BacklogError, parseRef } from "./item.ts";
import type { ListQuery } from "./inputs.ts";

/** Items with the number of the item each came from; filters and order use the `b.` alias. */
const SELECT = "SELECT b.*, f.seq AS from_seq FROM backlog b LEFT JOIN backlog f ON f.id = b.from_item";

const ORDER = `CASE b.state WHEN 'ongoing' THEN 0 WHEN 'todo' THEN 1 WHEN 'backlog' THEN 2 ELSE 3 END, b.priority, b.updated_at DESC, b.seq DESC`;

const SEARCHED = ["title", "goal", "body", "paths", "why", "evidence", "plan"] as const;

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

/** One item by ref or number, with its entities; undefined when no item has that number. */
export function getItem(db: DatabaseSync, repo: string, ref: string | number): Item | undefined {
	const seq = typeof ref === "number" ? ref : parseRef(ref);
	if (seq === undefined) return undefined;
	const row = db.prepare(`${SELECT} WHERE b.repo_key = ? AND b.seq = ?`).get(repo, seq) as Row<State> | undefined;
	return row ? enrichItems(db, repo, [toItem(row)])[0] : undefined;
}

/** The items that came from `item`, in board order. */
export function derived(db: DatabaseSync, repo: string, item: Item): Item[] {
	const rows = db
		.prepare(`${SELECT} WHERE b.from_item = ? ORDER BY ${ORDER}`)
		.all(item.rowId) as unknown as Row<State>[];
	return enrichItems(db, repo, rows.map(toItem));
}

/** The row id of the item `ref` names, refused when it is missing, is `item` itself, or already comes from `item`. */
export function origin(db: DatabaseSync, repo: string, ref: string, item?: Item): number {
	const target = getItem(db, repo, ref);
	if (!target) throw new BacklogError(`No backlog item ${visibleControls(ref)} to link from.`);
	if (!item) return target.rowId;
	if (target.rowId === item.rowId) throw new BacklogError(`${item.ref} cannot come from itself.`);
	const seen = new Set<number>();
	for (
		let at: Item | undefined = target;
		at?.from !== undefined && !seen.has(at.seq);
		at = getItem(db, repo, at.from)
	) {
		seen.add(at.seq);
		if (at.from === item.seq)
			throw new BacklogError(`${target.ref} already comes from ${item.ref}: the link would make a loop.`);
	}
	return target.rowId;
}

/** Items in `states` (every state when unset), ongoing first, then by priority and most recently updated; `total` counts past the limit. */
export function list(db: DatabaseSync, repo: string, query: ListQuery = {}): { items: Item[]; total: number } {
	const states = query.states?.length ? [...new Set(query.states)] : [...STATES];
	const where = [`b.repo_key = ?`, `b.state IN (${states.map(() => "?").join(", ")})`];
	const args: Array<string | number> = [repo, ...states];
	const text = query.query?.trim();
	if (text) {
		// Every text field matches any substring (so `backlog/store` finds a path); a tag matches only whole (`ui` is not found in `build`), with or without `#`.
		where.push(
			`(${SEARCHED.map((column) => `b.${column} LIKE ? ESCAPE '\\'`).join(" OR ")} OR (' ' || b.tags || ' ') LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM backlog_completions c WHERE c.item = b.id AND c.payload LIKE ? ESCAPE '\\'))`,
		);
		const like = `%${likeEscape(text)}%`;
		args.push(...SEARCHED.map(() => like), `% ${likeEscape(text.replace(/^#+/, ""))} %`, like);
	}
	if (query.from !== undefined) {
		where.push("b.from_item = ?");
		args.push(origin(db, repo, query.from));
	}
	const clause = where.join(" AND ");
	const total = (db.prepare(`SELECT COUNT(*) AS n FROM backlog b WHERE ${clause}`).get(...args) as { n: number }).n;
	const limit = query.limit === undefined ? -1 : Math.max(0, Math.floor(query.limit));
	const rows = db
		.prepare(`${SELECT} WHERE ${clause} ORDER BY ${ORDER} LIMIT ? OFFSET ?`)
		.all(...args, limit, query.offset ?? 0) as unknown as Row<State>[];
	return { items: enrichItems(db, repo, rows.map(toItem)), total };
}

/** How many items sit in each state. */
export function counts(db: DatabaseSync, repo: string): Record<State, number> {
	const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<State, number>;
	const rows = db
		.prepare("SELECT state, COUNT(*) AS n FROM backlog WHERE repo_key = ? GROUP BY state")
		.all(repo) as Array<{ state: State; n: number }>;
	for (const row of rows) counts[row.state] = row.n;
	return counts;
}

/** The newest `limit` notes after skipping `offset` of them, oldest first; a negative `limit` is every note. */
export function notes(db: DatabaseSync, item: Item, limit = 10, offset = 0): Note[] {
	const rows = db
		.prepare(
			"SELECT at, author, kind, text FROM backlog_notes WHERE item = ? ORDER BY at DESC, id DESC LIMIT ? OFFSET ?",
		)
		.all(item.rowId, limit, offset) as unknown as Note[];
	return rows.reverse().map((row) => ({ at: row.at, author: row.author, kind: row.kind, text: row.text }));
}

/** An item's comments, oldest first, marked with the item's ref. */
export function comments(db: DatabaseSync, repo: string, ref: string): BacklogComment[] {
	const item = getItem(db, repo, ref);
	if (!item) throw new BacklogError(`No backlog item ${ref}.`);
	return (
		db
			.prepare("SELECT id, at, author, text FROM backlog_comments WHERE item = ? ORDER BY id")
			.all(item.rowId) as unknown as Array<{ id: number; at: number; author: string; text: string }>
	).map((row) => ({ ...row, backlogId: item.ref }));
}

/** The repository's audit trail, newest first, redacted; `ref` narrows it to one item. */
export function audit(db: DatabaseSync, repo: string, ref?: string, limit = 500, before?: number): BacklogAudit[] {
	const rows = db
		.prepare(
			"SELECT * FROM backlog_audits WHERE repo_key = ? AND (? IS NULL OR backlog_id = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?",
		)
		.all(
			repo,
			ref ?? null,
			ref ?? null,
			before ?? null,
			before ?? null,
			Math.max(1, Math.min(500, Math.floor(limit))),
		) as Array<Record<string, string | number | null>>;
	return redactData(
		rows.reverse().map((row) => ({
			id: Number(row.id),
			backlogId: String(row.backlog_id),
			at: Number(row.at),
			actor: JSON.parse(String(row.actor)),
			action: String(row.action),
			entity: String(row.entity),
			before: row.before_value ? JSON.parse(String(row.before_value)) : null,
			after: row.after_value ? JSON.parse(String(row.after_value)) : null,
		})),
	);
}

export function noteCount(db: DatabaseSync, item: Item): number {
	return (
		db.prepare("SELECT COUNT(*) AS n FROM backlog_notes WHERE item = ?").get(item.rowId) as {
			n: number;
		}
	).n;
}

/** `assignee` when it is a session whose process still runs, else undefined (a finished session's claim can be taken over). */
export function liveHolder(db: DatabaseSync, assignee: string): string | undefined {
	const pid = sessionRunningPid(db, assignee);
	return pid !== undefined && pid !== process.pid ? assignee : undefined;
}
