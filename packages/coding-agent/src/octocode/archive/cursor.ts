import { isScanCursor } from "../history/search.ts";

/**
 * The one cursor an `archive` result gives, and the only way any result continues. A read has up to two parts that go
 * on: the record listing (its keyset cursor, `reads.ts`) and the result of the session-history part, a get, a profile or
 * an error scan (its next page, and for a regex search the scan position it pages, `history/search.ts`). Both travel in
 * one `a2.` cursor, so continuing repeats and skips nothing; a part the cursor does not name has ended.
 */
interface ArchiveCursor {
	/** The record listing's cursor; absent when the listing ended or is not continued. */
	records?: string;
	/** The page of the other part to show next; absent when that part ended. */
	page?: number;
	/** With `page`: the scan position the regex search pages from. */
	scan?: string;
	/** The call gave a cursor: a part it does not name is not read again. */
	continued: boolean;
}

const CURRENT = "a2.";
/** Cursors given before pages joined them: records and a scan position. */
const FORMER = "a1.";

const invalid = () => new Error("Invalid archive cursor; restart the search without cursor.");

function decode(cursor: string, prefix: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(cursor.slice(prefix.length), "base64url").toString());
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
	} catch {
		// Falls through to the error.
	}
	throw invalid();
}

/** How the call's `cursor` continues each part. A bare record cursor or scan cursor, from before `a2.`, continues that part alone. */
export function readArchiveCursor(given: string | undefined): ArchiveCursor {
	if (!given) return { continued: false };
	if (isScanCursor(given)) return { page: 1, scan: given, continued: true };
	// `isScanCursor` narrows a string that is not a scan cursor to never.
	const cursor: string = given;
	const former = cursor.startsWith(FORMER);
	if (!former && !cursor.startsWith(CURRENT)) return { records: cursor, continued: true };
	const { r, p, h } = decode(cursor, former ? FORMER : CURRENT);
	const records = typeof r === "string" && r ? r : undefined;
	const scan = isScanCursor(typeof h === "string" ? h : undefined) ? (h as string) : undefined;
	const page = Number.isSafeInteger(p) && (p as number) >= 1 ? (p as number) : scan ? 1 : undefined;
	if (!records && page === undefined) throw invalid();
	return { ...(records ? { records } : {}), ...(page ? { page } : {}), ...(scan ? { scan } : {}), continued: true };
}

/** The cursor that continues a read; undefined when every part ended. */
export function nextArchiveCursor(next: { records?: string; page?: number; scan?: string }): string | undefined {
	if (!next.records && next.page === undefined) return undefined;
	const value = {
		...(next.records ? { r: next.records } : {}),
		...(next.page !== undefined ? { p: next.page } : {}),
		...(next.scan ? { h: next.scan } : {}),
	};
	return `${CURRENT}${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

/** The next page of a paged part: the page after `page` while one remains, else the scan's next position, else none. */
export function nextPage(
	page: number,
	pages: number,
	scan?: { from?: string; next?: string },
): { page?: number; scan?: string } {
	if (page < pages) return { page: page + 1, ...(scan?.from ? { scan: scan.from } : {}) };
	return scan?.next ? { page: 1, scan: scan.next } : {};
}

/** The line every result that goes on ends with. */
export const continueLine = (cursor: string | undefined): string =>
	cursor ? `More remains: call again with cursor ${cursor} and the same other arguments.` : "";
