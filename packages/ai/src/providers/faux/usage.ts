import type {
	AssistantMessage,
	AssistantContent,
	ImageContent,
	Message,
	StreamOptions,
	TextContent,
	ToolResultMessage,
	TranscriptContext,
} from "../../types.ts";
import { createUsage } from "../../utils/assistant-message.ts";
import { getSystemMessageText } from "../../utils/text.ts";
import { estimateTokens } from "./messages.ts";

function contentToText(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.map((block) => {
			if (block.type === "text") {
				return block.text;
			}
			return `[image:${block.mimeType}:${block.data.length}]`;
		})
		.join("\n");
}

function assistantContentToText(content: AssistantContent[]): string {
	return content
		.map((block) => {
			if (block.type === "text") {
				return block.text;
			}
			if (block.type === "thinking") {
				return block.thinking;
			}
			if (block.type === "toolCall") return `${block.name}:${JSON.stringify(block.arguments)}`;
			if (block.type === "unsupported") return block.text;
			if (block.type === "resource") return block.text ?? block.uri;
			return `[${block.type}:${block.mimeType}]`;
		})
		.join("\n");
}

function toolResultToText(message: ToolResultMessage): string {
	return [message.toolName, ...message.content.map((block) => contentToText([block]))].join("\n");
}

function messageToText(message: Message): string {
	if (message.role === "system") {
		return [
			getSystemMessageText(message),
			...(message.toolsRemoved?.map((tool) => `tool-:${JSON.stringify(tool)}`) ?? []),
			...(message.toolsAdded?.map((tool) => `tool+:${JSON.stringify(tool)}`) ?? []),
		]
			.filter((part) => part.length > 0)
			.join("\n");
	}
	if (message.role === "user") {
		return contentToText(message.content);
	}
	if (message.role === "assistant") {
		return assistantContentToText(message.content);
	}
	return toolResultToText(message);
}

/** Length of the prompt text that joins `messages` with blank lines. */
function joinedLength(messages: readonly string[], count = messages.length): number {
	let length = count > 0 ? (count - 1) * 2 : 0;
	for (let index = 0; index < count; index++) length += messages[index].length;
	return length;
}

/**
 * Length of the common prefix of the two joined prompts. Equal messages are compared whole; characters are compared
 * only from the first message that differs.
 */
function commonPromptPrefixLength(previous: readonly string[], current: readonly string[]): number {
	let index = 0;
	while (index < previous.length && index < current.length && previous[index] === current[index]) index++;
	const rest = (messages: readonly string[]) =>
		index === messages.length ? "" : (index > 0 ? "\n\n" : "") + messages.slice(index).join("\n\n");
	return joinedLength(previous, index) + commonPrefixLength(rest(previous), rest(current));
}

function commonPrefixLength(a: string, b: string): number {
	const length = Math.min(a.length, b.length);
	let index = 0;
	while (index < length && a[index] === b[index]) {
		index++;
	}
	return index;
}

export function withUsageEstimate(
	message: AssistantMessage,
	context: TranscriptContext,
	options: StreamOptions | undefined,
	promptCache: Map<string, readonly string[]>,
): AssistantMessage {
	// One text per message; the whole prompt joins them with blank lines.
	const prompt = context.messages.map((message) => `${message.role}:${messageToText(message)}`);
	const promptLength = joinedLength(prompt);
	const promptTokens = Math.ceil(promptLength / 4);
	const outputTokens = estimateTokens(assistantContentToText(message.content));
	let input = promptTokens;
	let cacheRead = 0;
	let cacheWrite = 0;
	const sessionId = options?.sessionId;

	if (sessionId && options?.cacheRetention !== "none") {
		const previousPrompt = promptCache.get(sessionId);
		if (previousPrompt) {
			const cachedChars = commonPromptPrefixLength(previousPrompt, prompt);
			cacheRead = Math.ceil(cachedChars / 4);
			cacheWrite = Math.ceil((promptLength - cachedChars) / 4);
			input = Math.max(0, promptTokens - cacheRead);
		} else {
			cacheWrite = promptTokens;
		}
		promptCache.set(sessionId, prompt);
	}

	return {
		...message,
		usage: createUsage({ input, output: outputTokens, cacheRead, cacheWrite }),
	};
}
