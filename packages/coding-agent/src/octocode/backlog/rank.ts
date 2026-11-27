import type { AgentDb, Db } from "../../../../db/src/api.ts";
import { backlog } from "../../../../db/src/api.ts";
import { type Actor, auditActor, BacklogError, type Item } from "./item.ts";
import { getItem } from "./reads.ts";
import type { Row } from "./row.ts";

/** The gap between neighbouring ranks: a move writes one row until the gap between two cards is used up. */
const STEP = 1024;

/** Where to put an item in its column: the card that ends up directly above it, and the one directly below. */
export interface RankInput {
	/** Refuse when the item changed since this version was read (a board holding a stale copy). */
	version?: number;
	before?: string;
	after?: string;
}

const columnOf = (item: Item) => (item.closed ? "closed" : item.state);

/** The order a column shows: ranked cards first by rank, then by priority and number (what the page sorts by). */
function shown(rows: Row<string>[]): Row<string>[] {
	return [...rows].sort(
		(a, b) =>
			Number(a.rank === null) - Number(b.rank === null) ||
			(a.rank ?? 0) - (b.rank ?? 0) ||
			a.priority - b.priority ||
			a.seq - b.seq,
	);
}

function neighbour(db: Db, repo: string, item: Item, ref: string | undefined): Item | undefined {
	if (ref === undefined) return undefined;
	const found = getItem(db, repo, ref);
	if (!found) throw new BacklogError(`No backlog item ${ref}.`);
	if (found.seq === item.seq) throw new BacklogError(`${item.ref} cannot be placed next to itself.`);
	if (columnOf(found) !== columnOf(item))
		throw new BacklogError(`${found.ref} is in another column: move ${item.ref} there first.`);
	return found;
}

/** Writes `i * STEP` ranks (from `from`) down a column in the order given, one row each. */
function renumber(db: Db, rows: Row<string>[], from = 1): void {
	rows.forEach((row, i) => {
		row.rank = (from + i) * STEP;
		backlog.setItemRank(db, row.id, row.rank);
	});
}

/**
 * Places an item between two cards of its column by giving it a rank between theirs, so a move writes one row. A card that
 * was never ordered has no rank: the first time a neighbour lacks one, the column's unranked cards get ranks in the order the
 * page shows them. Ordering is neither a claim, an edit nor a state change: it checks the item's version but changes no
 * card's version, announces no change (`auditAfter`) and files a change note on the moved card.
 */
export function rankItem(
	agentDb: AgentDb,
	repo: string,
	now: () => number,
	ref: string,
	input: RankInput,
	actor: Actor,
): Item {
	return agentDb.withActor(auditActor(actor), () =>
		agentDb.transaction(() => {
			const db = agentDb.db;
			const item = getItem(db, repo, ref);
			if (!item) throw new BacklogError(`No backlog item ${ref}.`);
			if (input.version !== undefined && input.version !== item.version)
				throw new BacklogError(`${item.ref} changed elsewhere — reload it.`, item);
			if (actor.owners) throw new BacklogError("A subagent cannot reorder the board: ask your coordinator.");
			if (input.after === undefined && input.before === undefined)
				throw new BacklogError("Name the card to place the item after or before.");
			const above = neighbour(db, repo, item, input.after);
			const below = neighbour(db, repo, item, input.before);
			const column = columnOf(item);
			const rows = backlog.listItems(db, { repo, states: [column] }, -1, 0) as Row<string>[];
			const others = shown(rows.filter((row) => row.seq !== item.seq));
			const anchor = above ?? below!;
			const at = (target: Item) => others.findIndex((row) => row.seq === target.seq);
			const named = [above, below].filter((n): n is Item => n !== undefined);
			if (named.some((n) => others[at(n)]?.rank === null)) {
				const unranked = others.filter((row) => row.rank === null);
				const top = Math.max(0, ...others.map((row) => row.rank ?? 0));
				for (const [i, row] of unranked.entries()) {
					row.rank = top + (i + 1) * STEP;
					backlog.setItemRank(db, row.id, row.rank);
				}
			}
			const place = () => {
				const index = above ? at(above) + 1 : at(anchor);
				return { lo: others[index - 1]?.rank ?? undefined, hi: others[index]?.rank ?? undefined };
			};
			let { lo, hi } = place();
			let rank = lo === undefined ? (hi ?? 0) - STEP : hi === undefined ? lo + STEP : (lo + hi) / 2;
			if (lo !== undefined && hi !== undefined && !(rank > lo && rank < hi)) {
				// The gap is used up: renumber the whole column once.
				renumber(db, others);
				({ lo, hi } = place());
				rank = lo === undefined ? (hi ?? 0) - STEP : hi === undefined ? lo + STEP : (lo + hi) / 2;
			}
			backlog.setItemRank(db, item.rowId, rank);
			const where = above ? `after ${above.ref}` : `before ${below!.ref}`;
			backlog.addNote(db, item.rowId, now(), actor.id, "change", `rank: placed ${where} in ${column}`);
			return getItem(db, repo, item.seq)!;
		}),
	);
}
