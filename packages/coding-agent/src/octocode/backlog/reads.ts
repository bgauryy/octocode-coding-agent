import {
	type PathMatch,
	comparePathMatch,
	matchPaths,
	normalizeRepoPath,
} from "@octocodeai/octocode-contracts/backlogs";
import {
	LIST_STATES,
	type State,
	type Note,
	type BacklogComment,
	type BacklogAudit,
} from "@octocodeai/octocode-contracts/snapshot";
import { redactData, visibleControls } from "../../../../common/src/sanitize.ts";
import { type Db, backlog } from "../../../../db/src/api.ts";
import { sessionRunningPid } from "../shared/session-liveness.ts";
import { type Row, toItem } from "./row.ts";
import { enrichItems } from "./entities.ts";
import { type BacklogCounts, summarizeCounts } from "./counts.ts";
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

/** The number an item id names (`B12`, `b12`, `12`), refused when it names none. */
function seqOf(ref: string): number {
	const seq = parseRef(ref);
	if (seq === undefined) throw new BacklogError(`${visibleControls(ref)} is not an item id, e.g. "B12".`);
	return seq;
}

/** The SQL filter of a listing: item ids become numbers or row ids, and a missing parent or origin is refused. */
function filterOf(db: Db, repo: string, query: ListQuery): backlog.ItemFilter {
	const text = query.query?.trim();
	const words = query.title?.trim().split(/\s+/).filter(Boolean) ?? [];
	const parent = query.parentId === undefined ? undefined : getItem(db, repo, query.parentId);
	if (query.parentId !== undefined && !parent)
		throw new BacklogError(`No backlog item ${visibleControls(query.parentId)}.`);
	const tags = query.tags?.map((tag) => tag.trim().replace(/^#+/, "")).filter(Boolean);
	return {
		repo,
		states: query.states?.length ? [...new Set(query.states)] : [...LIST_STATES],
		...(text ? { text } : {}),
		...(query.from !== undefined ? { fromItem: origin(db, repo, query.from) } : {}),
		...(query.ids ? { seqs: query.ids.map(seqOf) } : {}),
		...(words.length ? { titleWords: words } : {}),
		...(parent ? { underItem: parent.rowId } : {}),
		...(query.types ? { types: query.types } : {}),
		...(query.maxPriority !== undefined ? { maxPriority: query.maxPriority } : {}),
		...(tags?.length ? { tags } : {}),
		...(query.dependsOn ? { dependsOn: query.dependsOn.map((ref) => `B${seqOf(ref)}`) } : {}),
		...(query.blocked !== undefined ? { blocked: query.blocked } : {}),
		...(query.assignees ? { assignees: query.assignees } : {}),
		...(query.updatedSince !== undefined ? { updatedSince: query.updatedSince } : {}),
		...(query.createdSince !== undefined ? { createdSince: query.createdSince } : {}),
	};
}

/** The path filter of a query: its entries normalized, none when the filter is absent or names only the repository root. */
const pathQueries = (query: ListQuery): string[] => (query.paths ?? []).map(normalizeRepoPath).filter(Boolean);

/**
 * Items matching `query` (every state when `states` is unset) in its sort order, board order by default; `total` counts
 * past the limit. With `paths`, items are ranked by how they touch a path (`matchPaths`) before that order, and
 * `pathMatches` says why each matched.
 */
export function list(
	db: Db,
	repo: string,
	query: ListQuery = {},
): { items: Item[]; total: number; pathMatches?: Map<string, PathMatch> } {
	const filter = filterOf(db, repo, query);
	const paths = pathQueries(query);
	if (paths.length) {
		// Matching reads paths, evidence and links, so it runs on the enriched items that pass the other filters.
		const rows = backlog.listItems(db, filter, -1, 0, query.sort) as Row<State>[];
		const pathMatches = new Map<string, PathMatch>();
		const matched = enrichItems(db, repo, rows.map(toItem)).filter((item) => {
			const match = matchPaths(item, paths);
			if (match) pathMatches.set(item.ref, match);
			return match !== undefined;
		});
		// Array.sort is stable: equal matches keep the requested order.
		matched.sort((a, b) => comparePathMatch(pathMatches.get(a.ref)!, pathMatches.get(b.ref)!));
		const start = query.offset ?? 0;
		const items = matched.slice(
			start,
			query.limit === undefined ? undefined : start + Math.max(0, Math.floor(query.limit)),
		);
		return { items, total: matched.length, pathMatches };
	}
	const total = backlog.countItems(db, filter);
	const limit = query.limit === undefined ? -1 : Math.max(0, Math.floor(query.limit));
	const rows = backlog.listItems(db, filter, limit, query.offset ?? 0, query.sort) as Row<State>[];
	return { items: enrichItems(db, repo, rows.map(toItem)), total };
}

/** How many items sit in each state and how many epics (by the state their items give them): the footer's and the board's counts. */
export function counts(db: Db, repo: string): BacklogCounts {
	return summarizeCounts(
		backlog.countHeads(db, repo).map((row) => ({
			key: String(row.id),
			type: row.type,
			state: row.state as State,
			closed: row.closed === 1,
			...(row.parent_id === null ? {} : { parent: String(row.parent_id) }),
		})),
	);
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

/**
 * The repository's audit trail, oldest first, redacted: the newest `limit` rows; `ref` narrows it to one item, `before`
 * to ids below it. `archived` (the same columns, read from the history archive) is merged in by id; a row in both
 * (archived, not yet deleted) is read once.
 */
export function audit(
	db: Db,
	repo: string,
	ref?: string,
	limit = 500,
	before?: number,
	archived: ReadonlyArray<Record<string, string | number | null>> = [],
): BacklogAudit[] {
	const size = Math.max(1, Math.min(500, Math.floor(limit)));
	const rows = backlog.auditRows(db, repo, ref, before, size);
	const stored = new Set(rows.map((row) => Number(row.id)));
	const merged = [...rows, ...archived.filter((row) => !stored.has(Number(row.id)))]
		.sort((a, b) => Number(b.id) - Number(a.id))
		.slice(0, size);
	return redactData(
		merged.reverse().map((row) => ({
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
