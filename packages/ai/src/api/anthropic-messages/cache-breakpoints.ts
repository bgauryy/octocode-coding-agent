import type {
	BetaContentBlockParam as ContentBlockParam,
	BetaCacheControlEphemeral as CacheControlEphemeral,
	MessageCreateParamsStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";

type MessageParam = MessageCreateParamsStreaming["messages"][number];
type CacheableBlock = ContentBlockParam & { cache_control?: CacheControlEphemeral | null };

/** Anthropic accepts at most four explicit cache breakpoints per request. */
export const MAX_CACHE_BREAKPOINTS = 4;

const CACHEABLE_BLOCK_TYPES = new Set(["text", "image", "tool_result", "tool_addition", "tool_removal"]);

/** A block that may carry `cache_control`; empty text and thinking blocks cannot be cached. */
export function isCacheableBlock(block: ContentBlockParam | undefined): block is CacheableBlock {
	if (!block || !CACHEABLE_BLOCK_TYPES.has(block.type)) return false;
	return block.type !== "text" || block.text.trim().length > 0;
}

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

function lastBlock(message: MessageParam): ContentBlockParam | undefined {
	return Array.isArray(message.content) ? message.content[message.content.length - 1] : undefined;
}

/**
 * Adds a second history breakpoint on the previous request's tail, the user or tool-result message that
 * precedes the final assistant turn. Anthropic only looks back 20 blocks from a breakpoint for an earlier
 * cache write, so a long assistant turn between two requests would otherwise push the last write out of reach.
 * Does nothing without a free slot (`usedBreakpoints` counts every marker already in the request), when the
 * history has no breakpoint to anchor on, or when the previous tail cannot carry one.
 */
export function addHistoryLookbackBreakpoint(
	messages: MessageParam[],
	cacheControl: CacheControlEphemeral,
	usedBreakpoints: number,
): void {
	if (usedBreakpoints >= MAX_CACHE_BREAKPOINTS) return;
	let finalIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (countCacheBreakpoints(lastBlock(messages[i])) > 0) {
			finalIndex = i;
			break;
		}
	}
	if (finalIndex < 0) return;
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
		if (message.role === "assistant") return;
		if (typeof message.content === "string") {
			if (message.content.trim().length > 0) {
				message.content = [{ type: "text", text: message.content, cache_control: cacheControl }];
			}
			return;
		}
		const block = lastBlock(message);
		if (isCacheableBlock(block) && !block.cache_control) {
			block.cache_control = cacheControl;
		}
		return;
	}
}
