import type { ModelMessage } from "ai";
import type { Model } from "../../types.ts";
import { fastHash } from "../../utils/hash.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../../utils/text.ts";
import { resolveTranscriptTools, type TranscriptContext } from "../../utils/transcript.ts";
import { resolveToolLoadingMode } from "../../utils/tool-loading.ts";
import { convertTools } from "../openai-completions/tools.ts";
import { transformMessages } from "../transform-messages.ts";
import { sanitizeToolCallId } from "../tool-call-id.ts";
import { getCompat } from "../openai-completions/compat.ts";
import { parseOpenAIReasoningDetails } from "../openai-completions/reasoning-details.ts";

export function completionsMessages(model: Model<"openai-completions">, context: TranscriptContext): ModelMessage[] {
	const compat = getCompat(model);
	const normalizeId = (id: string) => {
		const max = compat.toolCallIdMaxLength ?? 40;
		if (!id.includes("|")) return compat.toolCallIdMaxLength === undefined ? id : id.slice(0, max);
		const [call, ...rest] = id.split("|");
		const prefix = sanitizeToolCallId(call, Infinity);
		const item = sanitizeToolCallId(rest.join("|"), Infinity);
		const combined = item ? `${prefix}_${item}` : prefix;
		return combined.length <= max ? combined : `${prefix.slice(0, Math.max(1, max - 9))}_${fastHash(id).slice(0, 8)}`;
	};
	const source = transformMessages(context.messages, model, normalizeId);
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		resolveToolLoadingMode("openai-completions", compat),
	);
	let systemIndex = 0;
	const result: ModelMessage[] = [];
	let lastRole: string | undefined;
	let toolImages: { type: "image"; image: string; mediaType: string }[] = [];
	for (const [index, message] of source.entries()) {
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && message.role === "user")
			result.push({ role: "assistant", content: "I have processed the tool results." });
		lastRole = message.role;
		switch (message.role) {
			case "system": {
				const additions = systemIndex++ >= transcriptTools.foldedSystemMessages ? (message.toolsAdded ?? []) : [];
				if (additions.length)
					result.push({
						role: "system",
						content: "",
						providerOptions: { openaiCompatible: { tools: convertTools(additions, compat) as never } },
					});
				const content = sanitizeSurrogates(
					index === 0 ? getSystemMessageText(message) : renderSystemMessageUpdate(message),
				);
				if (content)
					result.push({
						role: "system",
						content,
						providerOptions:
							model.reasoning && compat.supportsDeveloperRole ? { openaiCompatible: { role: "developer" } } : undefined,
					});
				break;
			}
			case "user": {
				if (typeof message.content === "string")
					result.push({ role: "user", content: sanitizeSurrogates(message.content) });
				else {
					const content = message.content.flatMap<
						Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>[number]
					>((part) =>
						part.type === "text"
							? part.text
								? [{ type: "text" as const, text: sanitizeSurrogates(part.text) }]
								: []
							: [{ type: "image" as const, image: part.data, mediaType: part.mimeType }],
					);
					if (content.length) result.push({ role: "user", content });
				}
				break;
			}
			case "assistant": {
				const thinking = message.content.filter((part) => part.type === "thinking");
				const details = thinking.map((part) => parseOpenAIReasoningDetails(part.thinkingSignature)).find(Boolean);
				const content: Extract<ModelMessage, { role: "assistant" }>["content"] = [];
				for (const part of message.content) {
					if (part.type === "text" && part.text.trim())
						content.push({ type: "text", text: sanitizeSurrogates(part.text) });
					else if (part.type === "thinking" && part.thinking.trim())
						content.push({
							type: compat.requiresThinkingAsText ? "text" : "reasoning",
							text: sanitizeSurrogates(part.thinking),
						});
					else if (part.type === "toolCall")
						content.push({ type: "tool-call", toolCallId: part.id, toolName: part.name, input: part.arguments });
				}
				const metadata: Record<string, unknown> = {};
				if (details) metadata.reasoning_details = details;
				if (compat.requiresReasoningContentOnAssistantMessages && model.reasoning)
					metadata.reasoning_content = thinking.map((part) => part.thinking).join("\n");
				if (content.some((part) => part.type !== "reasoning"))
					result.push({
						role: "assistant",
						content,
						providerOptions: Object.keys(metadata).length ? { openaiCompatible: metadata as never } : undefined,
					});
				break;
			}
			case "toolResult": {
				const text = message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const images = message.content.filter((part) => part.type === "image");
				result.push({
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: message.toolCallId,
							toolName: message.toolName,
							output: {
								type: message.isError ? "error-text" : "text",
								value: sanitizeSurrogates(
									text.trim() ? text : images.length ? "(see attached image)" : "(no tool output)",
								),
							},
							providerOptions: compat.requiresToolResultName
								? { openaiCompatible: { name: message.toolName } }
								: undefined,
						},
					],
				});
				if (model.input.includes("image"))
					toolImages.push(
						...images.map((part) => ({ type: "image" as const, image: part.data, mediaType: part.mimeType })),
					);
				if (toolImages.length && source[index + 1]?.role !== "toolResult") {
					if (compat.requiresAssistantAfterToolResult)
						result.push({ role: "assistant", content: "I have processed the tool results." });
					result.push({ role: "user", content: toolImages });
					toolImages = [];
				}
				break;
			}
		}
	}
	return result.length ? result : [{ role: "user", content: "" }];
}
