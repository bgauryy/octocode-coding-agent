import { fitToolCallId } from "../tool-call-id.ts";
import {
	type Tool as BedrockTool,
	type CachePointBlock,
	type ContentBlock,
	ConversationRole,
	ImageFormat,
	type Message,
	type SystemContentBlock,
	type ToolChoice,
	type ToolConfiguration,
	type ToolResultContentBlock,
	ToolResultStatus,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import type {
	CacheRetention,
	ImageContent,
	JsonValue,
	Model,
	ProviderEnv,
	TextContent,
	Tool,
	ToolResultMessage,
} from "../../types.ts";
import { liftRootComposition } from "../../utils/json-schema-shape.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { type TranscriptContext, withoutInitialSystemMessage } from "../../utils/transcript.ts";
import { getJsonSchemaToolParameters, resolveJsonSchemaStrictSampling } from "../constrained-sampling.ts";
import { splitErrorToolResultImages, transformMessages } from "../transform-messages.ts";
import { getCachePoint } from "./cache-points.ts";
import { isAnthropicClaudeModel } from "./model-match.ts";
import { supportsThinkingSignature } from "./model-support.ts";
import { type BedrockOptions, EMPTY_TEXT_PLACEHOLDER } from "./types.ts";

/**
 * Builds the system blocks. Each prompt part (one, or a base and a project block when split) is followed by a cache
 * point, so a split prompt keeps the base block cached for sessions that share tools but differ in project context.
 */
export function buildSystemPrompt(
	systemPrompt: string | readonly string[] | undefined,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
	env?: ProviderEnv,
): SystemContentBlock[] | undefined {
	if (!systemPrompt) return undefined;

	const cachePoint = getCachePoint(model, cacheRetention, env);
	const blocks: SystemContentBlock[] = [];
	for (const text of typeof systemPrompt === "string" ? [systemPrompt] : systemPrompt) {
		blocks.push({ text: sanitizeSurrogates(text) });
		if (cachePoint) blocks.push({ cachePoint });
	}
	return blocks;
}

function createNonBlankTextBlock(text: string): ContentBlock.TextMember | undefined {
	const sanitized = sanitizeSurrogates(text);
	return sanitized.trim().length === 0 ? undefined : { text: sanitized };
}

function createRequiredTextBlock(text: string): ContentBlock.TextMember {
	return createNonBlankTextBlock(text) ?? { text: EMPTY_TEXT_PLACEHOLDER };
}

function sanitizeBedrockDocument(value: JsonValue): DocumentType {
	if (Array.isArray(value)) {
		return value.map(sanitizeBedrockDocument);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key.length > 0)
				.map(([key, nestedValue]) => [key, sanitizeBedrockDocument(nestedValue)]),
		);
	}
	return value;
}

function convertToolResultContent(content: (TextContent | ImageContent)[]): ToolResultContentBlock[] {
	const result: ToolResultContentBlock[] = [];
	for (const c of content) {
		if (c.type === "image") {
			result.push({ image: createImageBlock(c.mimeType, c.data) });
		} else {
			const textBlock = createNonBlankTextBlock(c.text);
			if (textBlock) result.push(textBlock);
		}
	}
	if (result.length === 0) result.push({ text: EMPTY_TEXT_PLACEHOLDER });
	return result;
}

export function convertMessages(
	context: TranscriptContext,
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
	env?: ProviderEnv,
): Message[] {
	const result: Message[] = [];
	const transformedMessages = transformMessages(withoutInitialSystemMessage(context.messages), model, (id) =>
		fitToolCallId(id),
	);

	for (let i = 0; i < transformedMessages.length; i++) {
		const m = transformedMessages[i];

		switch (m.role) {
			case "user": {
				const content: ContentBlock[] = [];
				if (typeof m.content === "string") {
					content.push(createRequiredTextBlock(m.content));
				} else {
					for (const c of m.content) {
						switch (c.type) {
							case "text": {
								const textBlock = createNonBlankTextBlock(c.text);
								if (textBlock) content.push(textBlock);
								break;
							}
							case "image":
								content.push({ image: createImageBlock(c.mimeType, c.data) });
								break;
							default:
								continue;
						}
					}
					if (content.length === 0) content.push({ text: EMPTY_TEXT_PLACEHOLDER });
				}
				pushUserMessage(result, content);
				break;
			}
			case "assistant": {
				// Skip assistant messages with empty content (e.g., from aborted requests)
				// Bedrock rejects messages with empty content arrays
				if (m.content.length === 0) {
					continue;
				}
				const contentBlocks: ContentBlock[] = [];
				for (const c of m.content) {
					switch (c.type) {
						case "text": {
							// Skip empty text blocks
							const textBlock = createNonBlankTextBlock(c.text);
							if (!textBlock) continue;
							contentBlocks.push(textBlock);
							break;
						}
						case "toolCall":
							contentBlocks.push({
								toolUse: { toolUseId: c.id, name: c.name, input: sanitizeBedrockDocument(c.arguments) },
							});
							break;
						case "thinking": {
							// Encrypted reasoning is opaque: replay the stored payload as the
							// `redactedContent` member instead of lowering it to reasoning text.
							if (c.redacted) {
								const redactedContent = decodeRedactedContent(c.thinkingSignature);
								if (redactedContent?.length) {
									contentBlocks.push({ reasoningContent: { redactedContent } });
								}
								continue;
							}
							// Skip empty thinking blocks
							const thinking = sanitizeSurrogates(c.thinking);
							if (thinking.trim().length === 0) continue;
							// Only Anthropic models support the signature field in reasoningText.
							// For other models, we omit the signature to avoid errors like:
							// "This model doesn't support the reasoningContent.reasoningText.signature field"
							if (supportsThinkingSignature(model)) {
								// Signatures arrive after thinking deltas. If a partial or externally
								// persisted message lacks a signature, Bedrock rejects the replayed
								// reasoning block. Fall back to plain text, matching Anthropic.
								if (!c.thinkingSignature || c.thinkingSignature.trim().length === 0) {
									contentBlocks.push({ text: thinking });
								} else {
									contentBlocks.push({
										reasoningContent: {
											reasoningText: {
												text: thinking,
												signature: c.thinkingSignature,
											},
										},
									});
								}
							} else {
								contentBlocks.push({
									reasoningContent: {
										reasoningText: { text: thinking },
									},
								});
							}
							break;
						}
						default:
							continue;
					}
				}
				// Skip if all content blocks were filtered out
				if (contentBlocks.length === 0) {
					continue;
				}
				result.push({
					role: ConversationRole.ASSISTANT,
					content: contentBlocks,
				});
				break;
			}
			case "toolResult": {
				// Collect all consecutive toolResult messages into a single user message
				// Bedrock requires all tool results to be in one message
				const toolResults: ContentBlock[] = [];
				// Claude rejects error tool results that contain anything but text, so for Claude their
				// images follow all tool results of the turn (#10794). Other models keep them in place.
				const errorImages: ContentBlock[] = [];
				let j = i;
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					const toolMsg = transformedMessages[j] as ToolResultMessage;
					const split = isAnthropicClaudeModel(model) ? splitErrorToolResultImages(toolMsg) : undefined;
					toolResults.push({
						toolResult: {
							toolUseId: toolMsg.toolCallId,
							content: convertToolResultContent(split?.content ?? toolMsg.content),
							status: toolMsg.isError ? ToolResultStatus.ERROR : ToolResultStatus.SUCCESS,
						},
					});
					if (split) {
						errorImages.push(
							{ text: split.caption },
							...split.images.map((image) => ({ image: createImageBlock(image.mimeType, image.data) })),
						);
					}
					j++;
				}

				// Skip the messages we've already processed
				i = j - 1;

				pushUserMessage(result, [...toolResults, ...errorImages]);
				break;
			}
			default:
				continue;
		}
	}

	// Add cache point to the last user message for supported Claude models when caching is enabled
	const cachePoint = getCachePoint(model, cacheRetention, env);
	if (cachePoint && result.length > 0) {
		const lastMessage = result[result.length - 1];
		if (lastMessage.role === ConversationRole.USER && lastMessage.content) {
			lastMessage.content.push({ cachePoint });
		}
	}

	return result;
}

/**
 * Converse requires alternating roles, so a user turn that follows another user turn (a
 * collapsed system update after tool results, or a queued user message) joins its content.
 */
function pushUserMessage(result: Message[], content: ContentBlock[]): void {
	const last = result[result.length - 1];
	if (last?.role === ConversationRole.USER && last.content) last.content.push(...content);
	else result.push({ role: ConversationRole.USER, content });
}

/** `cachePoint` ends the tool list with a checkpoint that covers every tool; it precedes the system prompt in the prefix. */
export function convertToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
	supportsStrictMode: boolean,
	cachePoint?: CachePointBlock,
): ToolConfiguration | undefined {
	if (!tools?.length) return undefined;
	if (toolChoice === "none") return undefined;

	const bedrockTools: BedrockTool[] = tools.map((declared) => {
		// Claude on Bedrock rejects anyOf/oneOf/allOf at the root of a tool schema.
		const tool = { ...declared, parameters: liftRootComposition(declared.parameters) };
		const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		return {
			toolSpec: {
				name: tool.name,
				description: tool.description,
				inputSchema: { json: getJsonSchemaToolParameters(tool, strict) as unknown as DocumentType },
				...(strict === true ? { strict: true } : {}),
			},
		};
	});

	if (cachePoint) bedrockTools.push({ cachePoint });

	let bedrockToolChoice: ToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return { tools: bedrockTools, toolChoice: bedrockToolChoice };
}

function createImageBlock(mimeType: string, data: string) {
	let format: ImageFormat;
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = ImageFormat.JPEG;
			break;
		case "image/png":
			format = ImageFormat.PNG;
			break;
		case "image/gif":
			format = ImageFormat.GIF;
			break;
		case "image/webp":
			format = ImageFormat.WEBP;
			break;
		default:
			throw new Error(`Unknown image type: ${mimeType}`);
	}

	return { source: { bytes: base64ToBytes(data) }, format };
}

function base64ToBytes(data: string): Uint8Array {
	const binaryString = atob(data);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

/**
 * Decodes a stored redacted payload. The AWS SDK hands the blob over as bytes, but a
 * persisted session carries it as base64. A hand-edited or externally produced session
 * can hold a signature that is not base64; drop that block instead of failing the
 * whole request.
 */
function decodeRedactedContent(signature: string | undefined): Uint8Array | undefined {
	if (!signature) return undefined;
	try {
		return base64ToBytes(signature);
	} catch {
		return undefined;
	}
}
