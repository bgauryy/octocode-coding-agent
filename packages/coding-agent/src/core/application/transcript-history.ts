import type { ApplicationHistory, ApplicationMessage, ApplicationTool } from "@octocodeai/octocode-contracts";
import { cloneDisplay } from "./normalize.ts";

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
	messageValues: Iterable<ApplicationMessage>,
	toolValues: Iterable<ApplicationTool>,
): { messages: ApplicationMessage[]; tools: ApplicationTool[] } {
	const sizes = new Map<object, number>();
	const size = (value: object) => sizes.get(value) ?? sizes.set(value, JSON.stringify(value).length).get(value)!;
	const total = (values: readonly object[]) => values.reduce((sum, value) => sum + size(value), 0);
	const all = [...messageValues];
	const allTools = [...toolValues];
	const messages = all.slice(-WINDOW_MESSAGES);
	while (messages.length > 1 && total(messages) > MESSAGE_BYTES) messages.shift();
	const select = () => {
		if (messages.length === all.length) return [...allTools];
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
	while (over() && tools.length) tools.shift();
	return cloneDisplay({ messages, tools });
}

/** One page of messages before `before` (newest last), with the tools that belong to them. */
export function transcriptHistory(
	messageMap: ReadonlyMap<string, ApplicationMessage>,
	toolMap: ReadonlyMap<string, ApplicationTool>,
	options: { before?: string; limit?: number } = {},
): ApplicationHistory {
	const all = [...messageMap.values()];
	const end = options.before === undefined ? all.length : all.findIndex((message) => message.id === options.before);
	if (end < 0) throw new Error("History cursor is not in this session");
	const limit = Math.max(1, Math.min(100, options.limit ?? 50));
	const messages = all.slice(Math.max(0, end - limit), end);
	const owned = belongsTo(messages);
	const firstOrder = messages[0]?.order ?? 0;
	const endOrder = all[end]?.order ?? Number.POSITIVE_INFINITY;
	const tools = [...toolMap.values()].filter(
		(tool) => owned(tool) || ((tool.order ?? -1) >= firstOrder && (tool.order ?? -1) < endOrder),
	);
	return cloneDisplay({
		messages,
		tools,
		...(messages.length ? { before: messages[0].id } : {}),
		hasMore: end > messages.length,
	});
}

/** The same object, or an equal copy rebuilt from the session file. */
export function sameMessage(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}
