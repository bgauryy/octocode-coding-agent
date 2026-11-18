import type { JSONValue } from "@ai-sdk/provider";
import type { AssistantModelMessage, ModelMessage, ToolModelMessage, UserModelMessage } from "ai";
import type { Model, Tool, TranscriptContext } from "../../types.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../../utils/text.ts";
import { getInitialSystemMessage } from "../../utils/transcript.ts";
import { transformMessages, splitErrorToolResultImages } from "../transform-messages.ts";
import { fitToolCallId } from "../tool-call-id.ts";
import { getAnthropicCompat } from "../anthropic-messages/compat.ts";
import { isAnthropicEffort, type AnthropicOptions } from "../anthropic-messages/types.ts";
import { anthropicToolSchema } from "./anthropic-map.ts";

export function anthropicSdkMessages(
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options: AnthropicOptions,
	inlineTools: boolean,
	disablePreferredStrictTools = false,
): ModelMessage[] {
	const compat = getAnthropicCompat(model);
	const initial = getInitialSystemMessage(context.messages);
	const messages: ModelMessage[] = [];
	const pending: ModelMessage[] = [];
	const disabled = model.reasoning && options.thinkingEnabled === false && model.thinkingLevelMap?.off !== null;
	const managed = model.compat?.supportsMidConvoEffort === true && !disabled;
	const definition = (declared: Tool) => {
		const { schema, strict } = anthropicToolSchema(declared, compat.supportsStrictTools, disablePreferredStrictTools);
		return {
			type: "function",
			name: declared.name,
			description: declared.description,
			inputSchema: schema,
			...(strict === true ? { strict: true } : {}),
			providerOptions: { anthropic: { eagerInputStreaming: compat.supportsEagerToolInputStreaming } },
		};
	};
	const transformed = transformMessages(context.messages, model, (id) => fitToolCallId(id));
	for (let index = 0; index < transformed.length; index++) {
		const message = transformed[index];
		if (message.role === "system") {
			if (index === 0 && initial) {
				const content = getSystemMessageText(message);
				if (content) messages.push({ role: "system", content: sanitizeSurrogates(content) });
				continue;
			}
			const content = sanitizeSurrogates(renderSystemMessageUpdate(message));
			const added = message.toolsAdded ?? [];
			const replaced = new Set(added.map((tool) => tool.name));
			const toolChanges = inlineTools
				? [
						...(message.toolsRemoved ?? [])
							.filter((tool) => !replaced.has(tool.name))
							.map((tool) => ({
								type: "tool_removal",
								toolName: tool.name,
							})),
						...added.map((tool) => ({ type: "tool_addition", tool: definition(tool) })),
					]
				: [];
			if (content.trim() || toolChanges.length)
				pending.push({
					role: "system",
					content,
					providerOptions: {
						anthropic: toolChanges.length ? { toolChanges: toolChanges as unknown as JSONValue } : {},
					},
				});
		} else if (message.role === "user") {
			const content =
				typeof message.content === "string"
					? [{ type: "text" as const, text: sanitizeSurrogates(message.content) }]
					: message.content.map((block) =>
							block.type === "text"
								? { type: "text" as const, text: sanitizeSurrogates(block.text) }
								: { type: "image" as const, image: block.data, mediaType: block.mimeType },
						);
			const nonempty = content.filter((part) => part.type !== "text" || part.text.trim());
			if (nonempty.length) messages.push({ role: "user", content: nonempty });
		} else if (message.role === "assistant") {
			const content: Exclude<AssistantModelMessage["content"], string> = [];
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim())
					content.push({ type: "text", text: sanitizeSurrogates(block.text) });
				if (block.type === "thinking") {
					const signature = block.thinkingSignature;
					if (block.redacted) {
						if (signature)
							content.push({
								type: "reasoning",
								text: "",
								providerOptions: { anthropic: { redactedData: signature } },
							});
					} else if (signature?.trim() || compat.allowEmptySignature) {
						if (block.thinking.trim() || signature?.trim())
							content.push({
								type: "reasoning",
								text: sanitizeSurrogates(block.thinking),
								providerOptions: { anthropic: { signature: signature?.trim() ? signature : "" } },
							});
					} else if (block.thinking.trim()) content.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
				}
				if (block.type === "toolCall")
					content.push({ type: "tool-call", toolCallId: block.id, toolName: block.name, input: block.arguments ?? {} });
			}
			// A reply that converts to nothing is dropped, and held system updates wait for the next sent one: flushed here
			// they would land before a user message, which Anthropic rejects ("role 'system' must precede an 'assistant'").
			if (!content.length) continue;
			messages.push(...pending.splice(0));
			if (
				managed &&
				message.api === model.api &&
				message.provider === model.provider &&
				isAnthropicEffort(message.providerThinkingLevel)
			)
				messages.push({
					role: "system",
					content: "",
					providerOptions: { anthropic: { effort: message.providerThinkingLevel } },
				});
			messages.push({ role: "assistant", content });
		} else if (message.role === "toolResult") {
			const content: ToolModelMessage["content"] = [];
			const images: Exclude<UserModelMessage["content"], string> = [];
			for (; index < transformed.length; index++) {
				const result = transformed[index];
				if (result.role !== "toolResult") {
					index--;
					break;
				}
				const split = splitErrorToolResultImages(result);
				const parts = split?.content ?? result.content;
				content.push({
					type: "tool-result",
					toolCallId: result.toolCallId,
					toolName: result.toolName,
					output: parts.every((part) => part.type === "text")
						? {
								type: result.isError ? "error-text" : "text",
								value: sanitizeSurrogates(parts.map((part) => (part.type === "text" ? part.text : "")).join("\n")),
							}
						: {
								type: "content",
								value: [
									...(parts.every((part) => part.type === "image")
										? [{ type: "text" as const, text: "(see attached image)" }]
										: []),
									...parts.map((part) =>
										part.type === "text"
											? { type: "text" as const, text: sanitizeSurrogates(part.text) }
											: { type: "image-data" as const, data: part.data, mediaType: part.mimeType },
									),
								],
							},
				});
				if (split)
					images.push(
						{ type: "text", text: split.caption },
						...split.images.map((image) => ({ type: "image" as const, image: image.data, mediaType: image.mimeType })),
					);
			}
			messages.push({ role: "tool", content });
			if (images.length)
				messages.push({ role: "user", content: images, providerOptions: { octocode: { joinPrevious: true } } });
		}
	}
	messages.push(...pending);
	if (managed)
		messages.push({
			role: "system",
			content: "",
			providerOptions: { anthropic: { effort: options.effort ?? "high" } },
		});
	return messages;
}
