import type {
	ChatCompletionTool,
	ChatCompletionAssistantMessageParam,
	ChatCompletionDeveloperMessageParam,
	ChatCompletionMessageParam,
	ChatCompletionSystemMessageParam,
	ChatCompletionToolMessageParam,
	ChatCompletionContentPartText,
} from "../ai-sdk/openai-wire-types.ts";
import type { CacheRetention, Model } from "../../types.ts";
import type { AssistantMessageDiagnostic } from "../../utils/diagnostics.ts";
import { instructionBlockTexts, keepsToolBreakpoint, type InstructionBlocks } from "../../utils/instruction-split.ts";
import {
	countCacheBreakpoints,
	findPreviousTailIndex,
	MAX_CACHE_BREAKPOINTS,
} from "../anthropic-messages/cache-breakpoints.ts";
import type { OpenAICompatCacheControl, ResolvedOpenAICompletionsCompat } from "./types.ts";

type ChatCompletionInstructionMessageParam = ChatCompletionDeveloperMessageParam | ChatCompletionSystemMessageParam;

type ChatCompletionTextPartWithCacheControl = ChatCompletionContentPartText & {
	cache_control?: OpenAICompatCacheControl;
};

type ChatCompletionToolWithCacheControl = ChatCompletionTool & {
	cache_control?: OpenAICompatCacheControl;
};

/** Claude models this process already told that they send no cache markers. */
const reportedUnmarkedClaude = new Set<string>();

/**
 * The one-time notice for a Claude model on Chat Completions that sends no cache markers: Claude caches only what
 * `cache_control` marks, so every turn is billed in full. The format is never turned on here, since only the user
 * knows whether their gateway forwards the field: OpenRouter's `anthropic/` ids are detected, but a LiteLLM or other
 * proxy has no fixed host, and a server that validates its request body rejects an unknown field. Undefined after the
 * model's first notice in this process, with caching off, with markers on, or for a model that names no Claude.
 */
export function takeUnmarkedClaudeNotice(
	model: Pick<Model<"openai-completions">, "provider" | "id" | "name">,
	compat: Pick<ResolvedOpenAICompletionsCompat, "cacheControlFormat">,
	cacheRetention: CacheRetention,
): AssistantMessageDiagnostic | undefined {
	if (cacheRetention === "none" || compat.cacheControlFormat === "anthropic") return undefined;
	if (!/claude/i.test(`${model.id} ${model.name}`)) return undefined;
	const key = `${model.provider}/${model.id}`;
	if (reportedUnmarkedClaude.has(key)) return undefined;
	reportedUnmarkedClaude.add(key);
	return {
		type: "cache_unavailable",
		timestamp: Date.now(),
		details: {
			reason: "no_cache_markers",
			model: key,
			fix: 'This Claude model gets no cache_control markers, so nothing is cached. If the gateway forwards Anthropic cache_control fields (LiteLLM documents it), set "compat": { "cacheControlFormat": "anthropic" } on the model in models.json.',
		},
	};
}

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

/**
 * Marks the leading instructions and last tool with `instructionCacheControl` and the last
 * conversation message with `cacheControl`. Either may be undefined to skip that layer. A second history breakpoint
 * on the previous request's tail uses the free slot, so a long assistant turn cannot push the last cache write out of
 * the 20-block lookback window.
 *
 * With `splitSystem`, the leading prompt becomes its cached blocks, each marked, and then the volatile block without
 * a marker. A second cached block replaces the tools-only marker: the base block's marker already covers the tools
 * that precede it, so the marker count never exceeds four. Without a leading string prompt equal to the blocks
 * joined, the prompt stays one block.
 *
 * With `toolCacheBoundary` (the first tool roles declare differently), the tool marker goes on the tool before it, so
 * an agent of one role reads the tool prefix another role wrote; with two cached blocks it takes the base block's
 * marker, as in the Anthropic adapter. A boundary that names the first tool or no tool changes nothing.
 */
export function applyAnthropicCacheControl(
	messages: ChatCompletionMessageParam[],
	tools: ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl | undefined,
	instructionCacheControl: OpenAICompatCacheControl | undefined,
	splitSystem?: InstructionBlocks,
	toolCacheBoundary?: string,
): void {
	if (instructionCacheControl) {
		const sharedEnd = toolCacheBoundary
			? Math.max(
					0,
					(tools ?? []).findIndex((tool) => toolName(tool) === toolCacheBoundary),
				)
			: 0;
		const sharedTool = sharedEnd > 0 ? tools?.[sharedEnd - 1] : undefined;
		const split =
			splitSystem && addSplitCacheControlToSystemPrompt(messages, splitSystem, instructionCacheControl, !!sharedTool);
		if (!split) addCacheControlToSystemPrompt(messages, instructionCacheControl);
		if (sharedTool) markTool(sharedTool, instructionCacheControl);
		else if (!split || keepsToolBreakpoint(splitSystem)) addCacheControlToLastTool(tools, instructionCacheControl);
	}
	if (cacheControl) {
		addCacheControlToLastConversationMessage(messages, cacheControl);
		addHistoryLookbackBreakpoint(messages, cacheControl, countCacheBreakpoints([messages, tools]));
	}
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
	const tailIndex = findPreviousTailIndex(messages);
	if (tailIndex < 0) return;
	const message = messages[tailIndex];
	if (message.role === "user" || message.role === "tool") addCacheControlToMessage(message, cacheControl);
}

/** `sharedTools`: a shared-tool marker takes the base block's slot when there are two cached blocks. */
function addSplitCacheControlToSystemPrompt(
	messages: ChatCompletionMessageParam[],
	blocks: InstructionBlocks,
	cacheControl: OpenAICompatCacheControl,
	sharedTools: boolean,
): boolean {
	const message = messages.find((candidate) => candidate.role === "system" || candidate.role === "developer");
	if (!message || message.content !== instructionBlockTexts(blocks).join("")) return false;
	const skipBase = sharedTools && blocks.cached.length > 1;
	message.content = [
		...blocks.cached.map((text, index) =>
			skipBase && index === 0 ? { type: "text", text } : { type: "text", text, cache_control: cacheControl },
		),
		...(blocks.volatile === undefined ? [] : [{ type: "text", text: blocks.volatile }]),
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
	tools: ChatCompletionTool[] | undefined,
	cacheControl: OpenAICompatCacheControl,
): void {
	if (!tools || tools.length === 0) {
		return;
	}

	markTool(tools[tools.length - 1], cacheControl);
}

function markTool(tool: ChatCompletionTool, cacheControl: OpenAICompatCacheControl): void {
	(tool as ChatCompletionToolWithCacheControl).cache_control = cacheControl;
}

function toolName(tool: ChatCompletionTool): string {
	return tool.type === "function" ? tool.function.name : tool.custom.name;
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
