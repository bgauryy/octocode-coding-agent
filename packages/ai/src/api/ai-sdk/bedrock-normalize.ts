import type { AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage } from "../../types.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { splitErrorToolResultImages } from "../transform-messages.ts";

/** Text Bedrock receives in place of content that is blank, since it rejects empty text blocks. */
const BEDROCK_EMPTY_TEXT = "<empty>";

export interface BedrockNormalizeOptions {
	/** Claude on Bedrock rejects images in error tool results: they move after the turn's tool results. */
	splitErrorImages: boolean;
	/** The model replays signed reasoning; unsigned thinking then goes back as plain text. */
	signedThinking: boolean;
}

function nonBlank(text: string): TextContent | undefined {
	const sanitized = sanitizeSurrogates(text);
	return sanitized.trim().length === 0 ? undefined : { type: "text", text: sanitized };
}

const emptyText = (): TextContent => ({ type: "text", text: BEDROCK_EMPTY_TEXT });

/** Drops empty property names at every depth: Bedrock rejects them in a replayed tool input document. */
function withoutEmptyKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutEmptyKeys);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key.length > 0)
				.map(([key, nested]) => [key, withoutEmptyKeys(nested)]),
		);
	return value;
}

function userContent(content: string | (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	if (typeof content === "string") return [nonBlank(content) ?? emptyText()];
	const kept: (TextContent | ImageContent)[] = [];
	for (const block of content) {
		if (block.type === "text") {
			const text = nonBlank(block.text);
			if (text) kept.push(text);
		} else if (block.type === "image") kept.push(block);
	}
	return kept.length > 0 ? kept : [emptyText()];
}

function assistantMessage(message: AssistantMessage, options: BedrockNormalizeOptions): AssistantMessage | undefined {
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			const text = nonBlank(block.text);
			if (text) content.push({ ...block, text: text.text });
		} else if (block.type === "toolCall") {
			content.push({ ...block, arguments: withoutEmptyKeys(block.arguments) as typeof block.arguments });
		} else if (block.type === "thinking") {
			// Redacted reasoning is opaque; the mapper replays its stored payload.
			if (block.redacted) {
				content.push(block);
				continue;
			}
			const thinking = sanitizeSurrogates(block.thinking);
			if (thinking.trim().length === 0) continue;
			// Bedrock rejects a signature-less reasoning block from a signing model: replay it as text.
			if (options.signedThinking && !block.thinkingSignature?.trim()) content.push({ type: "text", text: thinking });
			else content.push({ ...block, thinking });
		}
	}
	return content.length > 0 ? { ...message, content } : undefined;
}

function toolResultContent(content: (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	const kept: (TextContent | ImageContent)[] = [];
	for (const block of content) {
		if (block.type === "image") kept.push(block);
		else {
			const text = nonBlank(block.text);
			if (text) kept.push(text);
		}
	}
	return kept.length > 0 ? kept : [emptyText()];
}

/**
 * Applies the Bedrock content rules to a transcript before SDK conversion: blank text and surrogates,
 * unknown user blocks, empty assistant turns, empty tool input keys and Claude's error-result images.
 * System messages pass through unchanged.
 */
export function normalizeBedrockMessages(messages: Message[], options: BedrockNormalizeOptions): Message[] {
	const result: Message[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "user") result.push({ ...message, content: userContent(message.content) });
		else if (message.role === "assistant") {
			const kept = assistantMessage(message, options);
			if (kept) result.push(kept);
		} else if (message.role === "toolResult") {
			// One run of tool results; Claude's error images follow the whole run, in the same user turn.
			const moved: (TextContent | ImageContent)[] = [];
			let last: ToolResultMessage = message;
			for (; i < messages.length && messages[i].role === "toolResult"; i++) {
				const tool = messages[i] as ToolResultMessage;
				const split = options.splitErrorImages ? splitErrorToolResultImages(tool) : undefined;
				result.push({ ...tool, content: toolResultContent(split?.content ?? tool.content) });
				if (split) moved.push({ type: "text", text: split.caption }, ...split.images);
				last = tool;
			}
			i--;
			if (moved.length > 0) result.push({ role: "user", content: moved, timestamp: last.timestamp });
		} else result.push(message);
	}
	return result;
}
