import type { AssistantMessage, ImageContent, Message, TextContent, TranscriptContext, Usage } from "../types.ts";
import { getSystemMessageText } from "./text.ts";

export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent applicable assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent applicable assistant usage block. */
	trailingTokens: number;
	/** Index of the applicable message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

/**
 * Characters per token for every estimate that has no tokenizer: the context, what compaction adds back and the fixed
 * request. Prose runs near four, but code, paths and JSON (most of a tool result, a restored file or a tool schema)
 * tokenize nearer three, so three keeps estimates on the safe side. Every estimator in the workspace shares this ratio.
 */
export const CHARS_PER_TOKEN = 3;

/** An image counts as this many tokens. */
export const ESTIMATED_IMAGE_TOKENS = 1200;

const ESTIMATED_IMAGE_CHARS = ESTIMATED_IMAGE_TOKENS * CHARS_PER_TOKEN;

/** Tokens for `chars` characters by `CHARS_PER_TOKEN`, rounded up. */
export function charsToTokens(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

/** Characters of text-and-image content; every non-text block counts as an image. */
function estimateTextAndImageContentChars(content: string | ReadonlyArray<TextContent | ImageContent>): number {
	if (typeof content === "string") return content.length;

	let chars = 0;
	for (const block of content) chars += block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS;
	return chars;
}

/** Estimated tokens of user or tool-result style content: a string or text and image blocks. */
export function estimateContentTokens(content: string | ReadonlyArray<TextContent | ImageContent>): number {
	return charsToTokens(estimateTextAndImageContentChars(content));
}

/** Estimated tokens of serialized tool declarations. */
function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return charsToTokens(safeJsonStringify(tools).length);
}

/** Estimated tokens of one standard transcript message, without provider usage. */
export function estimateMessageTokens(message: Message): number {
	if (message.role === "system") {
		return (
			charsToTokens(getSystemMessageText(message).length) +
			estimateToolsTokens(message.toolsAdded) +
			estimateToolsTokens(message.toolsRemoved)
		);
	}
	if (message.role === "user" || message.role === "toolResult") return estimateContentTokens(message.content);

	let chars = 0;
	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else if (block.type === "toolCall") {
			chars += block.name.length + safeJsonStringify(block.arguments).length;
		} else if (block.type === "image" || block.type === "media") {
			chars += ESTIMATED_IMAGE_CHARS;
		} else if (block.type === "resource") {
			chars += (block.text ?? block.uri).length;
		} else {
			chars += block.text.length;
		}
	}
	return charsToTokens(chars);
}

/**
 * Usage of an assistant message that describes its context, or undefined for other roles and for aborted, error and
 * all-zero responses, which carry no valid counts.
 */
export function getContextUsage(message: { role: string }): Usage | undefined {
	if (message.role !== "assistant") return undefined;
	const assistant = message as Partial<AssistantMessage>;
	if (
		assistant.usage &&
		assistant.stopReason !== "aborted" &&
		assistant.stopReason !== "error" &&
		calculateContextTokens(assistant.usage) > 0
	) {
		return assistant.usage;
	}
	return undefined;
}

function getLastAssistantUsageInfo(
	messages: readonly { role: string; timestamp: number }[],
	staleByTimestamp: boolean,
): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		// A newer prefix message was inserted after this response (for example, a
		// compaction summary), so its usage cannot describe the current prefix.
		if (message.role === "assistant" && (!staleByTimestamp || message.timestamp >= latestPrefixTimestamp)) {
			const usage = getContextUsage(message);
			if (usage) usageInfo = { usage, index: i };
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

export interface ContextEstimateOptions {
	/**
	 * How to tell that an assistant usage no longer describes the current prefix. `timestamp` (default) ignores usage
	 * older than a message before it, such as an inserted compaction summary. `none` trusts the last valid usage: for
	 * hosts that already drop stale usage from session structure (compaction and context-edit entries), where wall-clock
	 * timestamps from imported sessions or other machines would discard valid usage.
	 */
	staleUsage?: "timestamp" | "none";
}

/**
 * Estimate context tokens from the last applicable assistant usage plus an estimate of what follows it; without usage,
 * estimate every message. Hosts with custom message roles pass their own `estimateMessage`.
 */
export function estimateContextTokensWith<M extends { role: string; timestamp: number }>(
	messages: readonly M[],
	estimateMessage: (message: M) => number,
	options: ContextEstimateOptions = {},
): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages, (options.staleUsage ?? "timestamp") === "timestamp");
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = 0;
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessage(messages[i]);
		}
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}

	let tokens = 0;
	for (const message of messages) tokens += estimateMessage(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

export function estimateContextTokens(context: TranscriptContext | readonly Message[]): ContextUsageEstimate {
	return estimateContextTokensWith("messages" in context ? context.messages : context, estimateMessageTokens);
}
