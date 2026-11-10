import type { Message, Model, Tool, TranscriptContext } from "../../types.ts";
import { resolveCacheRetention, resolvePromptCacheKey } from "../../utils/cache-policy.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../../utils/text.ts";
import { getCurrentTools } from "../../utils/transcript.ts";
import { NON_VISION_TOOL_IMAGE_PLACEHOLDER, NON_VISION_USER_IMAGE_PLACEHOLDER } from "../transform-messages.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "../constrained-sampling.ts";
import type {
	MistralChatMessage,
	MistralChatPayload,
	MistralContentChunk,
	MistralFunctionTool,
	MistralOptions,
	MistralRequestToolCall,
} from "./types.ts";

export function buildChatPayload(
	model: Model<"mistral-conversations">,
	context: TranscriptContext,
	messages: Message[],
	options?: MistralOptions,
): MistralChatPayload {
	const payload: MistralChatPayload = {
		model: model.id,
		stream: true,
		messages: toChatMessages(messages, model.input.includes("image")),
	};

	const currentTools = getCurrentTools(context.messages);
	if (currentTools.length > 0) payload.tools = toFunctionTools(currentTools, model.compat?.supportsStrictMode ?? true);
	if (options?.temperature !== undefined && model.compat?.supportsTemperature !== false)
		payload.temperature = options.temperature;
	if (options?.maxTokens !== undefined) payload.maxTokens = options.maxTokens;
	if (options?.toolChoice) payload.toolChoice = mapToolChoice(options.toolChoice);
	if (options?.promptMode) payload.promptMode = options.promptMode;
	if (options?.reasoningEffort) payload.reasoningEffort = options.reasoningEffort;
	if (resolveCacheRetention(options?.cacheRetention, options?.env) !== "none")
		payload.promptCacheKey = resolvePromptCacheKey(options);

	return payload;
}

export function shouldUsePromptCaching(options?: MistralOptions): options is MistralOptions & { sessionId: string } {
	return resolveCacheRetention(options?.cacheRetention, options?.env) !== "none" && !!options?.sessionId;
}

function toFunctionTools(tools: Tool[], supportsStrictMode: boolean): MistralFunctionTool[] {
	return tools.map((tool) => {
		const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: stripSymbolKeys(getJsonSchemaToolParameters(tool, strict)) as Record<string, unknown>,
				strict: strict ?? false,
			},
		};
	});
}

function stripSymbolKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => stripSymbolKeys(item));
	}

	if (value && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = stripSymbolKeys(entry);
		}
		return result;
	}

	return value;
}

function toChatMessages(messages: Message[], supportsImages: boolean): MistralChatMessage[] {
	const result: MistralChatMessage[] = [];

	for (const [index, msg] of messages.entries()) {
		if (msg.role === "system") {
			const text = index === 0 ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg);
			if (text.length > 0) result.push({ role: "system", content: sanitizeSurrogates(text) });
			continue;
		}

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				result.push({ role: "user", content: sanitizeSurrogates(msg.content) });
				continue;
			}
			const hadImages = msg.content.some((item) => item.type === "image");
			const content: MistralContentChunk[] = msg.content
				.filter((item) => item.type === "text" || supportsImages)
				.map((item) => {
					if (item.type === "text") return { type: "text", text: sanitizeSurrogates(item.text) };
					return { type: "image_url", imageUrl: `data:${item.mimeType};base64,${item.data}` };
				});
			if (content.length > 0) {
				result.push({ role: "user", content });
				continue;
			}
			if (hadImages && !supportsImages) {
				result.push({ role: "user", content: NON_VISION_USER_IMAGE_PLACEHOLDER });
			}
			continue;
		}

		if (msg.role === "assistant") {
			const contentParts: MistralContentChunk[] = [];
			const toolCalls: MistralRequestToolCall[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length > 0) {
						contentParts.push({ type: "text", text: sanitizeSurrogates(block.text) });
					}
					continue;
				}
				if (block.type === "thinking") {
					if (block.thinking.trim().length > 0) {
						contentParts.push({
							type: "thinking",
							thinking: [{ type: "text", text: sanitizeSurrogates(block.thinking) }],
						});
					}
					continue;
				}
				if (block.type !== "toolCall") continue;
				toolCalls.push({
					id: block.id,
					type: "function",
					function: { name: block.name, arguments: JSON.stringify(block.arguments || {}) },
					index: 0,
				});
			}

			const assistantMessage: MistralChatMessage = { role: "assistant", prefix: false };
			if (contentParts.length > 0) assistantMessage.content = contentParts;
			if (toolCalls.length > 0) assistantMessage.toolCalls = toolCalls;
			if (contentParts.length > 0 || toolCalls.length > 0) result.push(assistantMessage);
			continue;
		}

		const toolContent: MistralContentChunk[] = [];
		const textResult = msg.content
			.filter((part) => part.type === "text")
			.map((part) => (part.type === "text" ? sanitizeSurrogates(part.text) : ""))
			.join("\n");
		const hasImages = msg.content.some((part) => part.type === "image");
		const toolText = buildToolResultText(textResult, { hasImages, supportsImages });
		toolContent.push({ type: "text", text: msg.isError ? `${TOOL_ERROR_PREFIX}${toolText}` : toolText });
		for (const part of msg.content) {
			if (!supportsImages) continue;
			if (part.type !== "image") continue;
			toolContent.push({
				type: "image_url",
				imageUrl: `data:${part.mimeType};base64,${part.data}`,
			});
		}
		result.push({
			role: "tool",
			toolCallId: msg.toolCallId,
			name: msg.toolName,
			content: toolContent,
		});
	}

	return result;
}

const TOOL_ERROR_PREFIX = "[tool error] ";

/**
 * The text of a tool message for `text` and its images. Images the model cannot see are replaced by the shared
 * non-vision tool placeholder, appended to any text.
 */
function buildToolResultText(text: string, images: { hasImages: boolean; supportsImages: boolean }): string {
	const trimmed = text.trim();
	const imagesHidden = images.hasImages && !images.supportsImages;

	if (trimmed.length > 0) return imagesHidden ? `${trimmed}\n${NON_VISION_TOOL_IMAGE_PLACEHOLDER}` : trimmed;
	if (imagesHidden) return NON_VISION_TOOL_IMAGE_PLACEHOLDER;
	return images.hasImages ? "(see attached image)" : "(no tool output)";
}

function mapToolChoice(
	choice: MistralOptions["toolChoice"],
): "auto" | "none" | "any" | "required" | { type: "function"; function: { name: string } } | undefined {
	if (!choice) return undefined;
	if (choice === "auto" || choice === "none" || choice === "any" || choice === "required") {
		return choice;
	}
	return {
		type: "function",
		function: { name: choice.function.name },
	};
}
