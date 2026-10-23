import type {
	BetaTool,
	BetaCacheControlEphemeral as CacheControlEphemeral,
	BetaContentBlockParam as ContentBlockParam,
	BetaMessageParam as MessageParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { ImageContent, Message, TextContent, Tool, ToolResultMessage } from "../../types.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { renderSystemMessageUpdate } from "../../utils/text.ts";
import { splitErrorToolResultImages } from "../transform-messages.ts";
import { toClaudeCodeName } from "./claude-code.ts";
import { type AnthropicEffort, isAnthropicEffort } from "./types.ts";

function convertImageBlock(image: ImageContent) {
	return {
		type: "image" as const,
		source: {
			type: "base64" as const,
			media_type: image.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
			data: image.data,
		},
	};
}

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return convertImageBlock(block);
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

// Normalize tool call IDs to match Anthropic's required pattern and length
export function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertToolResult(msg: ToolResultMessage, content = msg.content): ContentBlockParam {
	return {
		type: "tool_result",
		tool_use_id: msg.toolCallId,
		content: convertContentBlocks(content),
		is_error: msg.isError,
	};
}

export interface ConvertedAnthropicMessages {
	messages: MessageParam[];
	assistantLevels: Map<number, AnthropicEffort>;
}

export function convertMessages(
	transformedMessages: Message[],
	isOAuthToken: boolean,
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
	managedProvider?: string,
	/** Converts tool definitions for native `tool_addition` blocks; undefined when tool changes are not native. */
	convertToolDefinitions?: (tools: Tool[]) => BetaTool[],
): ConvertedAnthropicMessages {
	const params: MessageParam[] = [];
	const assistantLevels = new Map<number, AnthropicEffort>();
	// Later system messages are held back and emitted directly before the next assistant
	// message (or at the end of the transcript). Anthropic requires `tool_result` blocks to
	// immediately follow their `tool_use`, so a system message between them is rejected; this
	// also mirrors where the managed-effort system messages are inserted. As a result an
	// update placed before a user message in the transcript lands after it on the wire.
	const pendingSystemMessages: MessageParam[] = [];
	const flushPendingSystemMessages = (): void => {
		params.push(...pendingSystemMessages);
		pendingSystemMessages.length = 0;
	};

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "system") {
			// Later system messages only reach this point when the model accepts them natively;
			// otherwise the transcript was collapsed into the leading message before conversion.
			const text = renderSystemMessageUpdate(msg);
			const blocks: ContentBlockParam[] = [];
			if (text.length > 0) blocks.push({ type: "text", text: sanitizeSurrogates(text) });
			if (convertToolDefinitions) {
				const added = msg.toolsAdded ?? [];
				const redefined = new Set(added.map((tool) => tool.name));
				for (const tool of msg.toolsRemoved ?? []) {
					// A new definition under the same name replaces the old one, so no removal is needed.
					if (redefined.has(tool.name)) continue;
					blocks.push({
						type: "tool_removal",
						tool: { type: "tool_reference", name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name },
					});
				}
				for (const definition of convertToolDefinitions(added)) {
					blocks.push({ type: "tool_addition", tool: { type: "tool_definition", definition } });
				}
			}
			if (blocks.length > 0) pendingSystemMessages.push({ role: "system", content: blocks });
		} else if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return convertImageBlock(item);
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			flushPendingSystemMessages();
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					const thinkingSignature = block.thinkingSignature;
					const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
					if (block.thinking.trim().length === 0 && !hasThinkingSignature) continue;
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text for Anthropic. Some compatible providers emit
					// and accept empty signatures, so let marked models preserve the block.
					if (!hasThinkingSignature) {
						blocks.push(
							allowEmptySignature
								? {
										type: "thinking",
										thinking: sanitizeSurrogates(block.thinking),
										signature: "",
									}
								: {
										type: "text",
										text: sanitizeSurrogates(block.thinking),
									},
						);
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			const messageIndex = params.length;
			params.push({
				role: "assistant",
				content: blocks,
			});
			if (
				managedProvider !== undefined &&
				msg.api === "anthropic-messages" &&
				msg.provider === managedProvider &&
				isAnthropicEffort(msg.providerThinkingLevel)
			) {
				assistantLevels.set(messageIndex, msg.providerThinkingLevel);
			}
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint.
			const toolResults: ContentBlockParam[] = [];
			// Anthropic rejects error tool results that contain anything but text, so their images follow
			// all tool results of the turn, which must come first in the user message (#10794).
			const errorImages: ContentBlockParam[] = [];
			let j = i;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const toolMsg = transformedMessages[j] as ToolResultMessage;
				const split = splitErrorToolResultImages(toolMsg);
				toolResults.push(convertToolResult(toolMsg, split?.content));
				if (split) {
					errorImages.push({ type: "text", text: split.caption }, ...split.images.map(convertImageBlock));
				}
				j++;
			}

			// Skip the messages we've already processed.
			i = j - 1;

			params.push({
				role: "user",
				content: [...toolResults, ...errorImages],
			});
		}
	}

	flushPendingSystemMessages();

	// Add cache_control to the last user or system message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user" || lastMessage.role === "system") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" ||
						lastBlock.type === "image" ||
						lastBlock.type === "tool_result" ||
						lastBlock.type === "tool_addition" ||
						lastBlock.type === "tool_removal")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return { messages: params, assistantLevels };
}

export function insertThinkingLevelMessages(
	converted: ConvertedAnthropicMessages,
	activeEffort: AnthropicEffort,
): MessageParam[] {
	const messages: MessageParam[] = [];
	for (let index = 0; index < converted.messages.length; index++) {
		const historicalEffort = converted.assistantLevels.get(index);
		if (historicalEffort !== undefined) {
			messages.push({ role: "system", content: [], output_config: { effort: historicalEffort } });
		}
		messages.push(converted.messages[index]);
	}
	messages.push({ role: "system", content: [], output_config: { effort: activeEffort } });
	return messages;
}
