import type {
	Endpoint,
	FeedCursor,
	FeedEntry,
	FeedPage,
	Traffic,
	TranscriptRef,
} from "@octocodeai/octocode-contracts/team";
import { type EndpointDirectory, endpointOf, withEndpoints } from "./endpoint.ts";

/** Messages a feed page holds when the caller names no limit: the live view stays bounded, history pages through `before`. */
export const LIVE_FEED_LIMIT = 30;

/**
 * An internal notice as a transcript holds it: a `custom_message` entry that no team message backs (a check-in, a lease or
 * dead-letter notice, mail from a local API client). `agentId` is the agent whose session holds it, its receiver.
 */
export interface FeedNotice {
	agentId: string;
	sessionId?: string;
	/** Line index in the receiver's session and the entry id there. */
	entry: number;
	entryId: string;
	at: number;
	/** The custom message type. */
	label: string;
	from: string;
	/** Set for mail from a local API client: `from` names the caller, which is not an agent. */
	external?: true;
	text: string;
}

export interface FeedQuery {
	/** Entries per page; defaults to `LIVE_FEED_LIMIT`. */
	limit?: number;
	/** The `next` of the page before: entries older than it. */
	before?: FeedCursor;
	/** Whether internal notices are listed; defaults to true. */
	internal?: boolean;
}

/** Where the sender's transcript holds what it did at `at`, when that can be known. */
export type TranscriptLocator = (agentId: string, at: number) => TranscriptRef | undefined;

const MESSAGE_PREFIX = "m:";

/** `m:000000000012`: padded so that keys of messages sort as their ids do. */
export const messageKey = (id: number): string => `${MESSAGE_PREFIX}${String(id).padStart(12, "0")}`;

/** Newest first; entries at the same time order by key, a notice (`n:`) above a message (`m:`). */
export function compareFeed(a: Pick<FeedEntry, "at" | "key">, b: Pick<FeedEntry, "at" | "key">): number {
	return b.at - a.at || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0);
}

export const cursorOf = (entry: Pick<FeedEntry, "at" | "key">): FeedCursor => ({ at: entry.at, key: entry.key });

const isBefore = (entry: FeedEntry, cursor: FeedCursor): boolean => compareFeed(entry, cursor) > 0;

/** The database position a feed cursor stands for: every message the cursor does not come after is older. */
export function messageBound(cursor: FeedCursor): { at: number; id: number } {
	return {
		at: cursor.at,
		id: cursor.key.startsWith(MESSAGE_PREFIX)
			? Number(cursor.key.slice(MESSAGE_PREFIX.length))
			: Number.MAX_SAFE_INTEGER,
	};
}

/** The feed row of a team message; `locate` links the sender's transcript near the send. */
export function messageEntry(traffic: Traffic, directory: EndpointDirectory, locate?: TranscriptLocator): FeedEntry {
	const message = withEndpoints(traffic, directory);
	const transcript = locate?.(message.from, message.at);
	return {
		key: messageKey(message.id),
		id: message.id,
		at: message.at,
		from: message.fromEndpoint!,
		to: message.toEndpoints!,
		text: message.text,
		state: message.state,
		...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
		...(message.replyRequired ? { replyRequired: true as const } : {}),
		...(message.deliveredAt === undefined ? {} : { deliveredAt: message.deliveredAt }),
		...(message.deliveries ? { deliveries: message.deliveries } : {}),
		...(message.dropped ? { dropped: message.dropped } : {}),
		...(transcript ? { transcript } : {}),
	};
}

/** The feed row of an internal notice: flagged `internal`, linked to the receiver's entry that holds it. */
export function noticeEntry(notice: FeedNotice, directory: EndpointDirectory): FeedEntry {
	const from: Endpoint = notice.external ? { id: notice.from, role: "external" } : endpointOf(notice.from, directory);
	return {
		key: `n:${notice.agentId}:${notice.entryId}`,
		at: notice.at,
		internal: true,
		label: notice.label,
		from,
		to: [endpointOf(notice.agentId, directory)],
		text: notice.text,
		transcript: {
			agentId: notice.agentId,
			...(notice.sessionId ? { sessionId: notice.sessionId } : {}),
			entry: notice.entry,
		},
	};
}

/**
 * `entries` (any order) as the page `query` asks for: newest first, `limit` of them older than `before`. `next` is set when
 * older entries remain; passing it back as `before` continues with no gap and no repeat.
 */
export function pageFeed(entries: readonly FeedEntry[], query: FeedQuery = {}): FeedPage {
	const limit = Math.max(1, query.limit ?? LIVE_FEED_LIMIT);
	const older = entries
		.filter(
			(entry) => (query.internal !== false || !entry.internal) && (!query.before || isBefore(entry, query.before)),
		)
		.sort(compareFeed);
	const page = older.slice(0, limit);
	const last = page.at(-1);
	return { entries: page, ...(older.length > limit && last ? { next: cursorOf(last) } : {}) };
}
