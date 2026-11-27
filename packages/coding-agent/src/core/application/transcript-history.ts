import type { ApplicationHistory, ApplicationMessage, ApplicationTool } from "@octocodeai/octocode-contracts";
import { asRecord } from "@octocodeai/octocode-contracts/guards";
import { cloneDisplay } from "./normalize.ts";
import { PersistentMap } from "@octocodeai/octocode-common/persistent-map";
import { historyMessagePage, historyTools } from "./history-index.ts";

const WINDOW_MESSAGES = 50;
const WINDOW_TOOLS = 50;
const MESSAGE_BYTES = 100000;
const WINDOW_BYTES = 150000;

/** Whether a tool belongs to one of these messages: its call's assistant message, or its result message. */
function belongsTo(messages: readonly ApplicationMessage[]): (tool: ApplicationTool) => boolean {
	const ids = new Set(messages.map((message) => message.id));
	const calls = new Set(messages.flatMap((message) => (message.toolCallId ? [message.toolCallId] : [])));
	return (tool) => (tool.messageId !== undefined && ids.has(tool.messageId)) || calls.has(tool.toolCallId);
}

/**
 * The newest messages a snapshot carries, with the tools that belong to them and every tool at or after the first of
 * them, bounded by count and serialized size. Once older messages are left out, the tools before the first carried
 * message are what history pages (`transcriptHistory`) return, so no tool is in neither. When the tools do not fit,
 * older messages leave first; past the last message, the oldest tools do.
 */
export function transcriptWindow(
	messageMap: ReadonlyMap<string, ApplicationMessage>,
	toolValues: Iterable<ApplicationTool>,
): { messages: ApplicationMessage[]; tools: ApplicationTool[] } {
	const sizes = new Map<object, number>();
	const size = (value: object) => sizes.get(value) ?? sizes.set(value, JSON.stringify(value).length).get(value)!;
	const total = (values: readonly object[]) => values.reduce((sum, value) => sum + size(value), 0);
	// Persistent storage can seek straight to the bounded tail; a reset may leave a plain Map.
	const messages =
		messageMap instanceof PersistentMap
			? [...messageMap.valuesFrom(messageMap.size - WINDOW_MESSAGES)]
			: [...messageMap.values()].slice(-WINDOW_MESSAGES);
	const allTools = [...toolValues];
	while (messages.length > 1 && total(messages) > MESSAGE_BYTES) messages.shift();
	const select = () => {
		if (messages.length === messageMap.size) return [...allTools];
		const cut = messages[0]?.order ?? Number.NEGATIVE_INFINITY;
		const owned = belongsTo(messages);
		return allTools.filter((tool) => (tool.order ?? Number.POSITIVE_INFINITY) >= cut || owned(tool));
	};
	let tools = select();
	const over = () => tools.length > WINDOW_TOOLS || total(messages) + total(tools) > WINDOW_BYTES;
	while (over() && messages.length > 1) {
		messages.shift();
		tools = select();
	}
	// Tools are kept in the order the transcript first saw them, oldest first.
	// Drop the excess prefix once; shifting a long tool-only history repeatedly is quadratic.
	if (tools.length > WINDOW_TOOLS) tools = tools.slice(-WINDOW_TOOLS);
	while (over() && tools.length) tools.shift();
	return cloneDisplay({ messages, tools });
}

/** One page of messages before `before` (newest last), with the tools that belong to them. */
export function transcriptHistory(
	messageMap: ReadonlyMap<string, ApplicationMessage>,
	toolMap: ReadonlyMap<string, ApplicationTool>,
	options: { before?: string; limit?: number } = {},
): ApplicationHistory {
	const limit = Math.max(1, Math.min(100, options.limit ?? 50));
	const page = historyMessagePage(messageMap, options.before, limit);
	const messages = page.values;
	const firstOrder = messages[0]?.order ?? 0;
	const tools = historyTools(toolMap, messages, firstOrder, page.endOrder);
	return cloneDisplay({
		messages,
		tools,
		...(messages.length ? { before: messages[0].id } : {}),
		hasMore: page.hasMore,
	});
}

/**
 * The same object, or an equal copy rebuilt from the session file. Two messages whose roles are different strings or
 * whose timestamps are different finite numbers cannot serialize alike, so they are told apart before serializing: a
 * message the views have not seen is compared with every message they hold.
 */
function sameMessage(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	const left = asRecord(a);
	const right = asRecord(b);
	if (typeof left.role === "string" && typeof right.role === "string" && left.role !== right.role) return false;
	const at = left.timestamp;
	const other = right.timestamp;
	if (
		typeof at === "number" &&
		typeof other === "number" &&
		Number.isFinite(at) &&
		Number.isFinite(other) &&
		at !== other
	)
		return false;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

/**
 * Splits what a rebuilt context added at its end: the ids of the messages already shown (announced before the
 * rebuild), then the messages no view has seen. Undefined when a shown message follows an unseen one: the views would
 * hold them in another order than the context does.
 */
function splitAdded<T>(
	identities: WeakMap<object, string>,
	sources: ReadonlyMap<string, unknown>,
	previous: readonly unknown[],
	added: readonly T[],
): { shown: string[]; unseen: T[] } | undefined {
	const result = { shown: [] as string[], unseen: [] as T[] };
	if (added.length === 0) return result;
	const taken = new Set<string>();
	for (const message of previous) {
		const id = identities.get(asRecord(message));
		if (id !== undefined) taken.add(id);
	}
	for (const message of added) {
		let id = identities.get(asRecord(message));
		if (id === undefined || taken.has(id)) {
			id = undefined;
			for (const [candidate, source] of sources) {
				if (taken.has(candidate) || !sameMessage(source, message)) continue;
				id = candidate;
				break;
			}
		}
		if (id === undefined) result.unseen.push(message);
		else if (result.unseen.length > 0) return undefined;
		else {
			taken.add(id);
			result.shown.push(id);
		}
	}
	return result;
}

/**
 * Take over a rebuilt context array whose messages equal `previous`: keep their ids and displayed state, so views
 * need no reset. The array may also have grown at its end. Messages the transcript already shows (a custom message is
 * announced, then the context is rebuilt with it) keep their ids; the ones no view has seen are returned for the
 * caller to show. Undefined when a message differs, so the views must be rebuilt.
 */
export function adoptContext<T>(
	identities: WeakMap<object, string>,
	sources: Map<string, unknown>,
	previous: readonly unknown[],
	next: readonly T[],
): T[] | undefined {
	if (next.length < previous.length || !previous.every((message, index) => sameMessage(message, next[index])))
		return undefined;
	const added = splitAdded(identities, sources, previous, next.slice(previous.length));
	if (!added) return undefined;
	const known = previous.length + added.shown.length;
	for (let index = 0; index < known; index++) {
		const message = next[index];
		const from = previous[index];
		const id = index < previous.length ? identities.get(asRecord(from)) : added.shown[index - previous.length];
		if (id === undefined || message === from) continue;
		identities.set(asRecord(message), id);
		if (sources.has(id)) sources.set(id, message);
	}
	return added.unseen;
}
