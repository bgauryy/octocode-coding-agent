import {
	STATES,
	type State,
	type Note,
	type BacklogComment,
	type BacklogAudit,
} from "@octocodeai/octocode-contracts/snapshot";
import { sessionRunningPid } from "../agentdb/liveness.ts";
import { redactData, visibleControls } from "../shared/sanitize.ts";
import { type Db, backlog } from "../agentdb/api.ts";
import { type Row, toItem } from "./row.ts";
import { enrichItems } from "./entities.ts";
import { type Item, BacklogError, parseRef } from "./item.ts";
import type { ListQuery } from "./inputs.ts";

/** One item by ref or number, with its entities; undefined when no item has that number. */
export function getItem(db: Db, repo: string, ref: string | number): Item | undefined {
	const seq = typeof ref === "number" ? ref : parseRef(ref);
	if (seq === undefined) return undefined;
	const row = backlog.itemBySeq(db, repo, seq) as Row<State> | undefined;
	return row ? enrichItems(db, repo, [toItem(row)])[0] : undefined;
}

/** The items that came from `item`, in board order. */
export function derived(db: Db, repo: string, item: Item): Item[] {
	const rows = backlog.derivedFrom(db, item.rowId) as Row<State>[];
	return enrichItems(db, repo, rows.map(toItem));
}

/** The row id of the item `ref` names, refused when it is missing, is `item` itself, or already comes from `item`. */
export function origin(db: Db, repo: string, ref: string, item?: Item): number {
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
export function list(db: Db, repo: string, query: ListQuery = {}): { items: Item[]; total: number } {
	const states = query.states?.length ? [...new Set(query.states)] : [...STATES];
	const text = query.query?.trim();
	const filter = {
		repo,
		states,
		...(text ? { text } : {}),
		...(query.from !== undefined ? { fromItem: origin(db, repo, query.from) } : {}),
	};
	const total = backlog.countItems(db, filter);
	const limit = query.limit === undefined ? -1 : Math.max(0, Math.floor(query.limit));
	const rows = backlog.listItems(db, filter, limit, query.offset ?? 0) as Row<State>[];
	return { items: enrichItems(db, repo, rows.map(toItem)), total };
}

/** How many items sit in each state. */
export function counts(db: Db, repo: string): Record<State, number> {
	const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<State, number>;
	const rows = backlog.stateCounts(db, repo) as Array<{ state: State; n: number }>;
	for (const row of rows) counts[row.state] = row.n;
	return counts;
}

/** The newest `limit` notes after skipping `offset` of them, oldest first; a negative `limit` is every note. */
export function notes(db: Db, item: Item, limit = 10, offset = 0): Note[] {
	const rows = backlog.notesPage(db, item.rowId, limit, offset) as unknown as Note[];
	return rows.reverse().map((row) => ({ at: row.at, author: row.author, kind: row.kind, text: row.text }));
}

/** An item's comments, oldest first, marked with the item's ref. */
export function comments(db: Db, repo: string, ref: string): BacklogComment[] {
	const item = getItem(db, repo, ref);
	if (!item) throw new BacklogError(`No backlog item ${ref}.`);
	return backlog.commentsOf(db, item.rowId).map((row) => ({ ...row, backlogId: item.ref }));
}

/** The repository's audit trail, newest first, redacted; `ref` narrows it to one item. */
export function audit(db: Db, repo: string, ref?: string, limit = 500, before?: number): BacklogAudit[] {
	const rows = backlog.auditRows(db, repo, ref, before, Math.max(1, Math.min(500, Math.floor(limit))));
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

export function noteCount(db: Db, item: Item): number {
	return backlog.noteCount(db, item.rowId);
}

/** `assignee` when it is a session whose process still runs, else undefined (a finished session's claim can be taken over). */
export function liveHolder(db: Db, assignee: string): string | undefined {
	const pid = sessionRunningPid(db, assignee);
	return pid !== undefined && pid !== process.pid ? assignee : undefined;
}
