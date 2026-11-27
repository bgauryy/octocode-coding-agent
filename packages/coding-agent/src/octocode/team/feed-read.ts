import type { FeedEntry, FeedPage, Member, Traffic } from "@octocodeai/octocode-contracts/team";
import { agentEvents, type Db } from "../../../../db/src/api.ts";
import type { DepartedAgent, EndpointDirectory } from "./endpoint.ts";
import {
	compareFeed,
	cursorOf,
	type FeedNotice,
	type FeedQuery,
	LIVE_FEED_LIMIT,
	messageBound,
	messageEntry,
	noticeEntry,
	type TranscriptLocator,
} from "./feed.ts";
import { history } from "./store/mail.ts";

/** What a feed reads from; a renderer gets a page from `readFeed` and never touches the database itself. */
export interface FeedSource {
	/** `limit` messages older than `before` (the newest when absent), newest first; nothing else caps the history. */
	traffic(limit: number, before?: { at: number; id: number }): Traffic[];
	directory(): EndpointDirectory;
	/** The internal notices of the sessions shown, any order; absent when none are read. */
	notices?(): readonly FeedNotice[];
	transcriptNear?: TranscriptLocator;
}

/**
 * One page of the feed: team messages and internal notices merged newest first. `next` is set while older entries remain;
 * `readFeed(source, { before: next })` continues with no gap and no repeat.
 */
export function readFeed(source: FeedSource, query: FeedQuery = {}): FeedPage {
	const limit = Math.max(1, query.limit ?? LIVE_FEED_LIMIT);
	const directory = source.directory();
	const bound = query.before ? messageBound(query.before) : undefined;
	// One row past the page says whether older ones remain.
	const messages = source
		.traffic(limit + 1, bound)
		.map((traffic) => messageEntry(traffic, directory, source.transcriptNear));
	const notices =
		query.internal === false
			? []
			: (source.notices?.() ?? [])
					.map((notice) => noticeEntry(notice, directory))
					.filter((entry) => !query.before || compareFeed(entry, query.before) > 0);
	const merged: FeedEntry[] = [...messages, ...notices].sort(compareFeed);
	const entries = merged.slice(0, limit);
	const last = entries.at(-1);
	return { entries, ...(merged.length > limit && last ? { next: cursorOf(last) } : {}) };
}

/** The last row an agent that left the team recorded in its `delete` event; the lookup caches the rows it found. */
export function departedLookup(db: Db): (id: string) => DepartedAgent | undefined {
	const known = new Map<string, DepartedAgent>();
	return (id) => {
		const cached = known.get(id);
		if (cached) return cached;
		const [event] = agentEvents.lastDeletes(db, [id]);
		if (!event) return undefined;
		const facts = departedOf(event);
		known.set(id, facts);
		return facts;
	};
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** What a `delete` event says of the agent: role, parent and session (the event's own columns), where it worked and its tmux pane. */
function departedOf(event: agentEvents.EventRow): DepartedAgent {
	const parentId = event.parentId ?? undefined;
	const sessionId = event.sessionId ?? undefined;
	return {
		...(text(event.data.role) ? { role: text(event.data.role) } : {}),
		...(parentId ? { parentId } : {}),
		...(sessionId ? { sessionId } : {}),
		...(text(event.data.cwd) ? { cwd: text(event.data.cwd) } : {}),
		...(text(event.data.branch) ? { branch: text(event.data.branch) } : {}),
		...(text(event.data.tmuxPane) ? { tmuxPane: text(event.data.tmuxPane) } : {}),
	};
}

export interface TeamFeedOptions {
	db: Db;
	/** The team's id (`TeamStore.team`); its messages are the feed. */
	team: string;
	/** The live members, read each time a page is read. */
	members: () => readonly Member[];
	/** The viewer's checkout: its folder is `main`. */
	root?: string;
	notices?: () => readonly FeedNotice[];
	transcriptNear?: TranscriptLocator;
}

/** The live team's feed: every message of the team, paged from the database, endpoints from the live members then the departed. */
export function teamFeedSource(options: TeamFeedOptions): FeedSource {
	const departed = departedLookup(options.db);
	return {
		traffic: (limit, before) => history(options.db, options.team, limit, before),
		directory: () => ({ members: options.members(), departed, ...(options.root ? { root: options.root } : {}) }),
		...(options.notices ? { notices: options.notices } : {}),
		...(options.transcriptNear ? { transcriptNear: options.transcriptNear } : {}),
	};
}
