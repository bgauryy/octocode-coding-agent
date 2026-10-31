import type { ApplicationHistory, ApplicationMessage, ApplicationTool } from "@octocodeai/octocode-contracts";
import { cloneDisplay } from "./normalize.ts";

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
	const ids = new Set(messages.map((message) => message.id));
	const calls = new Set(messages.flatMap((message) => (message.toolCallId ? [message.toolCallId] : [])));
	const firstOrder = messages[0]?.order ?? 0;
	const endOrder = all[end]?.order ?? Number.POSITIVE_INFINITY;
	const tools = [...toolMap.values()].filter(
		(tool) =>
			(tool.messageId && ids.has(tool.messageId)) ||
			calls.has(tool.toolCallId) ||
			((tool.order ?? -1) >= firstOrder && (tool.order ?? -1) < endOrder),
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
