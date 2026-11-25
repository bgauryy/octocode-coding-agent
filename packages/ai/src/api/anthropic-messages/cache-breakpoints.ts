// Caller-defined payloads (tool schemas, tool call arguments, tool definitions inside `tool_addition`) may use
// `cache_control` as an ordinary key; markers never live inside them.
const OPAQUE_KEYS = new Set(["input_schema", "inputSchema", "input", "parameters", "definition"]);

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

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Removers for the markers under `value`, in document order: Anthropic `cache_control` keys, Bedrock `cachePoint` blocks. */
function collectMarkers(value: unknown, out: (() => void)[]): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			if (isObject(item) && isObject(item.cachePoint)) {
				out.push(() => {
					const index = value.indexOf(item);
					if (index >= 0) value.splice(index, 1);
				});
			} else collectMarkers(item, out);
		}
		return;
	}
	if (!isObject(value)) return;
	for (const [key, child] of Object.entries(value)) {
		if (key === "cache_control") {
			if (isObject(child)) out.push(() => delete value[key]);
		} else if (!OPAQUE_KEYS.has(key)) collectMarkers(child, out);
	}
}

/** Request sections in the order the provider reads them: tools, then system, then messages. */
const SECTIONS = ["tools", "toolConfig", "system", "messages"] as const;

/**
 * Runtime guard: removes cache markers from a wire body until at most `max` remain, whatever the planner returned.
 * The earliest markers go first (tools, then system, then older messages), keeping the history tail that a growing
 * conversation reads next. Returns how many it removed.
 */
export function capCacheBreakpoints(body: Record<string, unknown>, max: number): number {
	const markers: (() => void)[] = [];
	for (const section of SECTIONS) collectMarkers(body[section], markers);
	const excess = markers.length - max;
	for (let i = 0; i < excess; i++) markers[i]();
	return Math.max(0, excess);
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
