import type { FeedCursor, FeedEntry } from "@octocodeai/octocode-contracts/team";
import type { SessionUI } from "../../../core/features/index.ts";
import { type PageChoice, type PageRow, showCommandPage } from "../../shared/page.ts";
import { type FeedSource, readFeed } from "../feed-read.ts";
import { entryFacts, type TranscriptReader } from "./detail.ts";
import { feedHeader, feedRow } from "./row.ts";

/** Entries one page of the list loads; the `older` row loads as many again. */
const PAGE_SIZE = 30;
/** The key that shows or hides internal notices. */
export const TOGGLE_KEY = "i";
const OLDER = "older";
const NONE = "none";

/** Shows a page and resolves with what the user did; `showCommandPage` in a session, a script in a test. */
export type ShowPage = (
	ui: Pick<SessionUI, "custom">,
	options: Parameters<typeof showCommandPage>[1],
) => Promise<PageChoice | undefined>;

/** What the page reads: the team feed and the transcripts behind it. */
export interface MessagesData {
	feed: FeedSource;
	transcript: TranscriptReader;
}

export interface MessagesPage extends MessagesData {
	ui: Pick<SessionUI, "custom">;
	/** Start with internal notices shown. */
	internal?: boolean;
	show?: ShowPage;
	pageSize?: number;
}

/** The entries loaded so far for one filter, newest first, and where older ones start. */
class Loaded {
	entries: FeedEntry[] = [];
	next: FeedCursor | undefined;
}

const keysFor = (internal: boolean): Record<string, string> => ({
	[TOGGLE_KEY]: internal ? "hide internal" : "show internal",
});

function listRows(loaded: Loaded, internal: boolean, size: number): PageRow[] {
	const keys = keysFor(internal);
	const now = Date.now();
	const rows = loaded.entries.map((entry) => feedRow(entry, keys, now));
	if (loaded.next) rows.push({ id: OLDER, name: "older…", detail: `load ${size} more`, keys });
	if (rows.length === 0) rows.push({ id: NONE, name: "none", detail: "no messages yet", keys });
	return rows;
}

/**
 * `/messages`: every message of the team, newest first, internal notices hidden until the toggle key shows them. Enter on a
 * row opens its page (the whole body, the sender's thinking and output); Escape goes back, and on the list closes it.
 * Returns after the user leaves.
 */
export async function messagesPage(options: MessagesPage): Promise<void> {
	const show = options.show ?? showCommandPage;
	const size = options.pageSize ?? PAGE_SIZE;
	let internal = options.internal === true;
	const loaded = new Loaded();
	const load = (older: boolean): string | undefined => {
		const page = readFeed(options.feed, {
			limit: size,
			internal,
			...(older && loaded.next ? { before: loaded.next } : {}),
		});
		const firstNew = page.entries[0]?.key;
		loaded.entries = older ? [...loaded.entries, ...page.entries] : page.entries;
		loaded.next = page.next;
		return firstNew;
	};
	load(false);
	let initialId: string | undefined;
	for (;;) {
		const choice = await show(options.ui, {
			title: "Messages",
			sections: [{ heading: "Newest first", rows: listRows(loaded, internal, size) }],
			notes: [
				internal
					? `Internal notices shown (check-ins, lease and dead-letter notices, API mail) · ${TOGGLE_KEY} hides them`
					: `Internal notices hidden · ${TOGGLE_KEY} shows them`,
				`${loaded.entries.length} loaded${loaded.next ? " · older ones below" : ""}`,
			],
			...(initialId ? { initialId } : {}),
		});
		if (!choice) return;
		initialId = choice.id;
		if (choice.key === TOGGLE_KEY) {
			internal = !internal;
			initialId = load(false);
		} else if (choice.id === OLDER) {
			initialId = load(true) ?? OLDER;
		} else {
			const entry = loaded.entries.find((candidate) => candidate.key === choice.id);
			if (entry)
				await show(options.ui, {
					title: entry.id === undefined ? "Notice" : `Message #${entry.id}`,
					facts: entryFacts(entry, options.transcript),
					sections: [],
					nested: true,
				});
		}
	}
}

/** The first page as plain lines, for a session without a UI. */
export function messagesText(feed: FeedSource, internal: boolean, size = PAGE_SIZE): string {
	const { entries, next } = readFeed(feed, { limit: size, internal });
	if (entries.length === 0) return "No messages yet.";
	const lines = entries.map((entry) => feedHeader(entry));
	return [...lines, ...(next ? [`… older messages exist: /messages in a terminal pages through them`] : [])].join("\n");
}
