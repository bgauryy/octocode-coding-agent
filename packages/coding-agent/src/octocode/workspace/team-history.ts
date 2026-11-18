import type { FeedCursor, Traffic } from "@octocodeai/octocode-contracts/team";
import type { Db } from "../../../../db/src/api.ts";
import { cursorOf, messageBound, messageKey } from "../team/feed.ts";
import { history } from "../team/store/mail.ts";

/** Message rows one page request looks through, whoever they involve: the team is shared by every session of the repository. */
const MAX_SCAN = 2000;
/** Rows read from the database at a time. */
const BATCH = 200;

/** `limit` of this session's messages older than `before`, newest first; `next` while older rows may remain. */
export interface HistoryPage {
	traffic: Traffic[];
	next?: FeedCursor;
}

type ReadPage = (limit: number, before?: { at: number; id: number }) => Traffic[];

/**
 * Pages the team's history through `read` and keeps the messages `involved` accepts. It stops when `limit` are kept or
 * after `MAX_SCAN` rows; `next` is the position of the last row looked at, set whenever older rows may remain, so a
 * page that filled with other sessions' messages is empty but still continues.
 */
export function involvedHistory(
	read: ReadPage,
	involved: (message: Traffic) => boolean,
	limit: number,
	before?: FeedCursor,
	maxScan = MAX_SCAN,
): HistoryPage {
	const traffic: Traffic[] = [];
	let bound = before ? messageBound(before) : undefined;
	let last: Traffic | undefined;
	let scanned = 0;
	for (;;) {
		const size = Math.min(BATCH, maxScan - scanned);
		const rows = size > 0 ? read(size, bound) : [];
		for (const row of rows) {
			last = row;
			scanned += 1;
			if (!involved(row)) continue;
			traffic.push(row);
			if (traffic.length === limit) return more(traffic, row, rows[rows.length - 1] !== row || rows.length === size);
		}
		if (rows.length < size) return { traffic };
		if (scanned >= maxScan && last) return more(traffic, last, true);
		bound = last ? { at: last.at, id: last.id } : bound;
	}
}

function more(traffic: Traffic[], at: Traffic, possible: boolean): HistoryPage {
	return { traffic, ...(possible ? { next: cursorOf({ at: at.at, key: messageKey(at.id) }) } : {}) };
}

/** The team's history from the database, for `involvedHistory`. */
export const readHistory =
	(db: Db, team: string): ReadPage =>
	(limit, before) =>
		history(db, team, limit, before);
