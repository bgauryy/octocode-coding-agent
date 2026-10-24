import type OpenAI from "openai";
import type {
	ChatCompletionAssistantMessageParam,
	ChatCompletionDeveloperMessageParam,
	ChatCompletionMessageParam,
	ChatCompletionSystemMessageParam,
	ChatCompletionToolMessageParam,
	ChatCompletionContentPartText,
} from "openai/resources/chat/completions.js";
import type { CacheRetention } from "../../types.ts";
import { countCacheBreakpoints } from "../anthropic-messages/cache-breakpoints.ts";
import type { OpenAICompatCacheControl, ResolvedOpenAICompletionsCompat } from "./types.ts";

type ChatCompletionInstructionMessageParam = ChatCompletionDeveloperMessageParam | ChatCompletionSystemMessageParam;

type ChatCompletionTextPartWithCacheControl = ChatCompletionContentPartText & {
	cache_control?: OpenAICompatCacheControl;
};

type ChatCompletionToolWithCacheControl = OpenAI.Chat.Completions.ChatCompletionTool & {
	cache_control?: OpenAICompatCacheControl;
};

export function getCompatCacheControl(
	compat: ResolvedOpenAICompletionsCompat,
	cacheRetention: CacheRetention,
): OpenAICompatCacheControl | undefined {
	if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") {
		return undefined;
	}

	const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : undefined;
	return { type: "ephemeral", ...(ttl ? { ttl } : {}) };
}

/** The system prompt split into a base and a project block (see `splitSystemMessageAtBoundary`). */
export type SplitSystemPrompt = readonly [base: string, project: string];

/** Anthropic accepts at most four explicit cache breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Marks the leading instructions and last tool with `instructionCacheControl` and the last
 * conversation message with `cacheControl`. Either may be undefined to skip that layer. A second history breakpoint
 * on the previous request's tail uses the free slot, so a long assistant turn cannot push the last cache write out of
 * the 20-block lookback window.
 *
 * With `splitSystem`, the leading prompt becomes two marked blocks and the tools-only marker is dropped: the base
 * block's marker already covers the tools that precede it, so the marker count is unchanged. Without a leading
 * string prompt equal to the two blocks joined, the prompt stays one block.
 */
export function applyAnthropicCacheControl(
	messages: ChatCompletionMessageParam[],
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl | undefined,
	instructionCacheControl: OpenAICompatCacheControl | undefined,
	splitSystem?: SplitSystemPrompt,
): void {
	if (instructionCacheControl) {
		const split = splitSystem && addSplitCacheControlToSystemPrompt(messages, splitSystem, instructionCacheControl);
		if (!split) {
			addCacheControlToSystemPrompt(messages, instructionCacheControl);
			addCacheControlToLastTool(tools, instructionCacheControl);
		}
	}
	if (cacheControl) {
		addCacheControlToLastConversationMessage(messages, cacheControl);
		addHistoryLookbackBreakpoint(messages, cacheControl, countCacheBreakpoints([messages, tools]));
	}
}

function hasCacheControl(message: ChatCompletionMessageParam): boolean {
	return Array.isArray(message.content) && countCacheBreakpoints(message.content[message.content.length - 1]) > 0;
}

/**
 * Marks the user or tool-result message that precedes the final assistant turn, the previous request's tail.
 * Does nothing without a free slot, without a conversation breakpoint to anchor on, or when the previous tail cannot
 * carry a marker.
 */
function addHistoryLookbackBreakpoint(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
	usedBreakpoints: number,
): void {
	if (usedBreakpoints >= MAX_CACHE_BREAKPOINTS) return;
	let finalIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (hasCacheControl(messages[i])) {
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
		if (message.role === "user" || message.role === "tool") addCacheControlToMessage(message, cacheControl);
		return;
	}
}

function addSplitCacheControlToSystemPrompt(
	messages: ChatCompletionMessageParam[],
	[base, project]: SplitSystemPrompt,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	const message = messages.find((candidate) => candidate.role === "system" || candidate.role === "developer");
	if (!message || message.content !== `${base}${project}`) return false;
	message.content = [
		{ type: "text", text: base, cache_control: cacheControl },
		{ type: "text", text: project, cache_control: cacheControl },
	] as ChatCompletionTextPartWithCacheControl[];
	return true;
}

function addCacheControlToSystemPrompt(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (const message of messages) {
		if (message.role === "system" || message.role === "developer") {
			addCacheControlToInstructionMessage(message, cacheControl);
			return;
		}
	}
}

function addCacheControlToLastConversationMessage(
	messages: ChatCompletionMessageParam[],
	cacheControl: OpenAICompatCacheControl,
): void {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
			if (addCacheControlToMessage(message, cacheControl)) {
				return;
			}
		}
	}
}

function addCacheControlToLastTool(
	tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	if (!tools || tools.length === 0) {
		return;
	}

	const lastTool = tools[tools.length - 1] as ChatCompletionToolWithCacheControl;
	lastTool.cache_control = cacheControl;
}

function addCacheControlToInstructionMessage(
	message: ChatCompletionInstructionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	return addCacheControlToTextContent(message, cacheControl);
}

function addCacheControlToMessage(
	message: ChatCompletionMessageParam,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
		return addCacheControlToTextContent(message, cacheControl);
	}
	return false;
}

function addCacheControlToTextContent(
	message:
		| ChatCompletionInstructionMessageParam
		| ChatCompletionAssistantMessageParam
		| ChatCompletionToolMessageParam
		| Extract<ChatCompletionMessageParam, { role: "user" }>,
	cacheControl: OpenAICompatCacheControl,
): boolean {
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) {
			return false;
		}
		message.content = [
			{
				type: "text",
				text: content,
				cache_control: cacheControl,
			},
		] as ChatCompletionTextPartWithCacheControl[];
		return true;
	}

	if (!Array.isArray(content)) {
		return false;
	}

	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i];
		if (part?.type === "text") {
			const textPart = part as ChatCompletionTextPartWithCacheControl;
			textPart.cache_control = cacheControl;
			return true;
		}
	}

	return false;
}
