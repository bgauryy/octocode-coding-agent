import type { ApplicationHistory, ApplicationMessage, ApplicationTool } from "@octocodeai/octocode-contracts";

/** Messages one "Load earlier messages" request asks for (`limit` in `application-api.ts`). */
const HISTORY_PAGE = 50;

/**
 * The loaded history: a contiguous run of messages directly before the live window. The live stream keeps only its
 * newest messages, so messages it drops move here; `limit` (one page per request) bounds what is retained, and the
 * oldest messages beyond it are dropped and stay reachable through `before`.
 */
export interface LoadedHistory {
	messages: ApplicationMessage[];
	tools: ApplicationTool[];
	/** The next page's cursor: the oldest retained message, or the live window's first message before any. */
	before?: string;
	hasMore: boolean;
	limit: number;
}

type Transcript = { messages: readonly ApplicationMessage[]; tools?: readonly ApplicationTool[] };

/** Start or deepen the history before a request, so messages evicted while it is in flight have room. */
export function requestHistory(history: LoadedHistory | undefined, liveFirst: string | undefined): LoadedHistory {
	return history
		? { ...history, limit: history.limit + HISTORY_PAGE }
		: { messages: [], tools: [], before: liveFirst, hasMore: true, limit: HISTORY_PAGE };
}

/** Prepend a page read before `cursor`; a page is dropped when trimming moved the history past its cursor. */
export function addHistoryPage(history: LoadedHistory, page: ApplicationHistory, cursor: string | undefined) {
	if (history.before !== cursor) return history;
	return trim({
		...history,
		messages: unique([...page.messages, ...history.messages], (message) => message.id),
		tools: unique([...page.tools, ...history.tools], (tool) => tool.toolCallId),
		hasMore: page.hasMore,
	});
}

/** Move what the live window dropped between two of its states: its messages, and tools older than its first message. */
export function retainEvicted(history: LoadedHistory, previous: Transcript, current: Transcript): LoadedHistory {
	const liveMessages = new Set(current.messages.map((message) => message.id));
	const liveTools = new Set((current.tools ?? []).map((tool) => tool.toolCallId));
	const messages = previous.messages.filter((message) => !liveMessages.has(message.id));
	const owned = owner(messages);
	const boundary = current.messages[0]?.order ?? Number.POSITIVE_INFINITY;
	const tools = (previous.tools ?? []).filter(
		(tool) => !liveTools.has(tool.toolCallId) && (owned(tool) || (tool.order ?? Number.POSITIVE_INFINITY) < boundary),
	);
	if (!messages.length && !tools.length) return history;
	return trim({
		...history,
		messages: unique([...history.messages, ...messages], (message) => message.id),
		tools: unique([...history.tools, ...tools], (tool) => tool.toolCallId),
	});
}

function trim(history: LoadedHistory): LoadedHistory {
	const excess = history.messages.length - history.limit;
	if (excess <= 0) return { ...history, before: history.messages[0]?.id ?? history.before };
	const messages = history.messages.slice(excess);
	const dropped = owner(history.messages.slice(0, excess));
	const first = messages[0]?.order ?? Number.NEGATIVE_INFINITY;
	return {
		...history,
		messages,
		tools: history.tools.filter((tool) => !dropped(tool) && !((tool.order ?? Number.POSITIVE_INFINITY) < first)),
		before: messages[0]?.id,
		hasMore: true,
	};
}

/** Whether a tool belongs to one of these messages, by the links the host's history page uses. */
function owner(messages: readonly ApplicationMessage[]) {
	const ids = new Set(messages.map((message) => message.id));
	const calls = new Set(messages.flatMap((message) => (message.toolCallId ? [message.toolCallId] : [])));
	return (tool: ApplicationTool) =>
		(tool.messageId !== undefined && ids.has(tool.messageId)) || calls.has(tool.toolCallId);
}

/** One entry per key at its first position, holding the latest value. */
function unique<T>(values: readonly T[], key: (value: T) => string): T[] {
	return [...new Map(values.map((value) => [key(value), value])).values()];
}
