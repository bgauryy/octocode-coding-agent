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

/** A tokenizer family whose characters per token were measured on provider receipts. */
type TokenFamily = "anthropic" | "openai" | "deepseek";

/**
 * Characters per token on provider receipts, per family (2026-11-19: 9,079 consecutive requests whose only new content
 * was tool results, and the first requests of real sessions). Claude 5.5 reads 2.4–2.6 characters per token, OpenAI's
 * o200k about 3.5 on tool results and up to about 4.9 on a whole first request. `estimate` is the dense end of the
 * family's range, for an estimate that feeds a budget or a trigger, where more tokens is the safe side; `floor` is the
 * sparse end, for a lower bound on tokens.
 *
 * DeepSeek is an estimate from little traffic (2026-11-19, this machine's transcripts, DeepSeek-V4-Flash only): 27
 * tool-result steps in 12 sessions read a median 3.3 characters per token (3.1–3.7 from p10 to p90), 8 whole first
 * requests 3.6–3.9, and one compaction's estimate at Claude's ratio came to 1.34 times the provider's count. Its floor
 * sits just above the sparsest first request. The same method read 2.3 (tool results) and 2.55 (first requests) for
 * Claude, 3.4 and 4.8 for GPT-6.1.
 */
const FAMILY_CHARS_PER_TOKEN: Readonly<Record<TokenFamily, { estimate: number; floor: number }>> = {
	anthropic: { estimate: 2.5, floor: 2.6 },
	openai: { estimate: 3.5, floor: 4.9 },
	deepseek: { estimate: 3.3, floor: 4 },
};

/**
 * Characters per token for an estimate without a known model family: the densest family measured (Claude), so a
 * budget or trigger sized with it holds for every family. Prefer `charsPerToken(model)` where the model is known.
 */
export const CHARS_PER_TOKEN = FAMILY_CHARS_PER_TOKEN.anthropic.estimate;

/** Characters per token for a lower bound without a known family: the sparsest family measured. */
const FLOOR_CHARS_PER_TOKEN = Math.max(...Object.values(FAMILY_CHARS_PER_TOKEN).map((ratio) => ratio.floor));

/** The part of a model its tokenizer family is read from. */
export interface TokenModel {
	id: string;
	provider?: string;
}

/**
 * The model's tokenizer family, from its id (a vendor prefix such as `anthropic/` or `us.anthropic.` is ignored), or
 * DeepSeek's own provider.
 */
function tokenFamily(model: TokenModel | undefined): TokenFamily | undefined {
	const id = model?.id.toLowerCase().split("/").at(-1) ?? "";
	if (id.includes("claude")) return "anthropic";
	if (/^(gpt-|chatgpt-|o\d|codex-)/.test(id)) return "openai";
	if (id.includes("deepseek") || model?.provider?.toLowerCase() === "deepseek") return "deepseek";
	return undefined;
}

/**
 * Characters per token for `model`: its family's measured ratio, else the conservative default. `floor` asks for the
 * sparse end, for a lower bound on tokens (a check that a prefix was read at least in part).
 */
export function charsPerToken(model?: TokenModel, bound: "estimate" | "floor" = "estimate"): number {
	const family = tokenFamily(model);
	if (bound === "floor") return family ? FAMILY_CHARS_PER_TOKEN[family].floor : FLOOR_CHARS_PER_TOKEN;
	return family ? FAMILY_CHARS_PER_TOKEN[family].estimate : CHARS_PER_TOKEN;
}

/** An image counts as this many tokens. */
export const ESTIMATED_IMAGE_TOKENS = 1200;

/** Tokens for `chars` characters at `model`'s ratio (`charsPerToken`, the default without a model), rounded up. */
export function charsToTokens(chars: number, model?: TokenModel): number {
	return Math.ceil(chars / charsPerToken(model));
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

/**
 * Estimated tokens of user or tool-result style content: a string or text and image blocks, at `model`'s ratio (the
 * default without one). Every non-text block counts as an image.
 */
export function estimateContentTokens(
	content: string | ReadonlyArray<TextContent | ImageContent>,
	model?: TokenModel,
): number {
	if (typeof content === "string") return charsToTokens(content.length, model);
	let chars = 0;
	let images = 0;
	for (const block of content) {
		if (block.type === "text") chars += block.text.length;
		else images++;
	}
	return charsToTokens(chars, model) + images * ESTIMATED_IMAGE_TOKENS;
}

/** Estimated tokens of serialized tool declarations. */
function estimateToolsTokens(tools: readonly unknown[] | undefined, model?: TokenModel): number {
	if (!tools || tools.length === 0) return 0;
	return charsToTokens(safeJsonStringify(tools).length, model);
}

/** Estimated tokens of one standard transcript message, without provider usage, at `model`'s ratio (the default without one). */
export function estimateMessageTokens(message: Message, model?: TokenModel): number {
	if (message.role === "system") {
		return (
			charsToTokens(getSystemMessageText(message).length, model) +
			estimateToolsTokens(message.toolsAdded, model) +
			estimateToolsTokens(message.toolsRemoved, model)
		);
	}
	if (message.role === "user" || message.role === "toolResult") return estimateContentTokens(message.content, model);

	let chars = 0;
	let images = 0;
	for (const block of message.content) {
		if (block.type === "text") {
			chars += block.text.length;
		} else if (block.type === "thinking") {
			chars += block.thinking.length;
		} else if (block.type === "toolCall") {
			chars += block.name.length + safeJsonStringify(block.arguments).length;
		} else if (block.type === "image" || block.type === "media") {
			images++;
		} else if (block.type === "resource") {
			chars += (block.text ?? block.uri).length;
		} else {
			chars += block.text.length;
		}
	}
	return charsToTokens(chars, model) + images * ESTIMATED_IMAGE_TOKENS;
}

/**
 * Usage of an assistant message that describes its context, or undefined for other roles and for aborted, error and
 * all-zero responses, which carry no valid counts.
 */
function getContextUsage(message: { role: string }): Usage | undefined {
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

/** `estimateContextTokensWith` for standard messages, estimated at `model`'s ratio (the default without one). */
export function estimateContextTokens(
	context: TranscriptContext | readonly Message[],
	model?: TokenModel,
): ContextUsageEstimate {
	return estimateContextTokensWith("messages" in context ? context.messages : context, (message) =>
		estimateMessageTokens(message, model),
	);
}
