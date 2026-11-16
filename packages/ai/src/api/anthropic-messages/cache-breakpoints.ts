/** Anthropic accepts at most four explicit cache breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

// Caller-defined payloads (tool schemas, tool call arguments, tool definitions inside `tool_addition`) may use
// `cache_control` as an ordinary key; markers never live inside them.
const OPAQUE_KEYS = new Set(["input_schema", "input", "parameters", "definition"]);

/** Counts block-level `cache_control` markers in a request section (system, tools or messages). */
export function countCacheBreakpoints(value: unknown): number {
	if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countCacheBreakpoints(item), 0);
	if (typeof value !== "object" || value === null) return 0;
	let count = 0;
	for (const [key, child] of Object.entries(value)) {
		if (key === "cache_control") count += typeof child === "object" && child !== null ? 1 : 0;
		else if (!OPAQUE_KEYS.has(key)) count += countCacheBreakpoints(child);
	}
	return count;
}

/** A message in Anthropic or Anthropic-compatible chat format: only its role and content are read. */
interface HistoryMessage {
	role: string;
	content?: unknown;
}

function lastContentPart(message: HistoryMessage): unknown {
	return Array.isArray(message.content) ? message.content[message.content.length - 1] : undefined;
}

/**
 * Index of the previous request's tail: the last non-empty message before the final assistant turn, where the final
 * assistant turn is the one before the last message whose last content part carries a cache marker. Returns -1 when
 * no message carries a marker or the tail is itself an assistant message. The caller decides whether the tail can
 * carry a marker.
 */
export function findPreviousTailIndex(messages: readonly HistoryMessage[]): number {
	let finalIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (countCacheBreakpoints(lastContentPart(messages[i])) > 0) {
			finalIndex = i;
			break;
		}
	}
	if (finalIndex < 0) return -1;
	let assistantIndex = -1;
	for (let i = finalIndex - 1; i >= 0; i--) {
		if (messages[i].role === "assistant") {
			assistantIndex = i;
			break;
		}
	}
	for (let i = assistantIndex - 1; i >= 0; i--) {
		const message = messages[i];
		if (Array.isArray(message.content) && message.content.length === 0) continue;
		return message.role === "assistant" ? -1 : i;
	}
	return -1;
}
