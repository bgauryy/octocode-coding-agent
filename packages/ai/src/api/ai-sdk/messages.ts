import { jsonSchema, tool, type ModelMessage, type ToolSet } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { Api, Model, TranscriptContext } from "../../types.ts";
import { getSystemMessageText } from "../../utils/text.ts";
import { getCurrentTools } from "../../utils/transcript.ts";
import { transformMessages } from "../transform-messages.ts";

function replayMetadata(
	model: Model<Api>,
	signature: string | undefined,
	reasoning: boolean,
): ProviderOptions | undefined {
	if (!signature) return undefined;
	if (model.api === "anthropic-messages") return { anthropic: { signature } };
	if (model.api === "google-generative-ai" || model.api === "google-vertex")
		return { google: { thoughtSignature: signature } };
	if (model.api.endsWith("responses")) {
		const parsed = JSON.parse(signature) as { id: string; phase?: string; encrypted_content?: string };
		const value = {
			itemId: parsed.id,
			...(reasoning ? { reasoningEncryptedContent: parsed.encrypted_content } : { phase: parsed.phase }),
		};
		return { openai: value, azure: value };
	}
	return undefined;
}

export function sdkMessages(model: Model<Api>, context: TranscriptContext): ModelMessage[] {
	return transformMessages(context.messages, model).map((message): ModelMessage => {
		switch (message.role) {
			case "system":
				return { role: "system", content: getSystemMessageText(message) };
			case "user":
				return {
					role: "user",
					content:
						typeof message.content === "string"
							? message.content
							: message.content.map((block) => {
									if (block.type === "text") return { type: "text" as const, text: block.text };
									if (block.type === "image")
										return {
											type: "file" as const,
											mediaType: block.mimeType,
											data: { type: "data" as const, data: block.data },
										};
									throw new Error("AI SDK does not support this user content");
								}),
				};
			case "assistant":
				return {
					role: "assistant",
					content: message.content
						.filter(
							(block) =>
								(model.api !== "google-generative-ai" && model.api !== "google-vertex") ||
								block.type !== "text" ||
								block.text.trim().length > 0 ||
								Boolean(block.textSignature),
						)
						.map((block) => {
							if (block.type === "text")
								return {
									type: "text" as const,
									text: block.text,
									providerOptions: replayMetadata(model, block.textSignature, false),
								};
							if (block.type === "thinking")
								return {
									type: "reasoning" as const,
									text: block.thinking,
									providerOptions: replayMetadata(model, block.thinkingSignature, true),
								};
							if (block.type === "toolCall") {
								const [toolCallId, itemId] = block.id.split("|");
								return {
									type: "tool-call" as const,
									toolCallId,
									toolName: block.name,
									input: block.arguments,
									providerOptions: model.api.endsWith("responses")
										? { openai: { itemId }, azure: { itemId } }
										: replayMetadata(model, block.thoughtSignature, false),
								};
							}
							if (
								(model.api === "google-generative-ai" || model.api === "google-vertex") &&
								(block.type === "image" || block.type === "media" || block.type === "resource")
							) {
								const data = block.type === "resource" ? undefined : block.data;
								const uri = block.type === "image" ? undefined : block.uri;
								if (!data && !uri) throw new Error("Gemini replay file has no data or URI");
								if (model.api === "google-vertex" && !data)
									return {
										type: "text" as const,
										text: `[file: ${uri} (${block.mimeType ?? "application/octet-stream"})]`,
									};
								return {
									type: "file" as const,
									mediaType: block.mimeType ?? "application/octet-stream",
									data: data
										? { type: "data" as const, data }
										: { type: "reference" as const, reference: { google: uri! } },
									providerOptions: replayMetadata(model, block.thoughtSignature, false),
								};
							}
							throw new Error(`AI SDK replay requires native conversion for ${block.type}`);
						}),
				};
			case "toolResult":
				return {
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: message.toolCallId.split("|")[0],
							toolName: message.toolName,
							output: message.content.some((block) => block.type === "image")
								? {
										type: "content",
										value: message.content.map((block) =>
											block.type === "image"
												? {
														type: "file" as const,
														mediaType: block.mimeType,
														data: { type: "data" as const, data: block.data },
													}
												: { type: "text" as const, text: block.text },
										),
									}
								: {
										type: message.isError ? "error-text" : "text",
										value: message.content
											.map((block) => {
												if (block.type !== "text")
													throw new Error("AI SDK tool-result images require native conversion");
												return block.text;
											})
											.join("\n"),
									},
						},
					],
				};
		}
	});
}

export function sdkTools(context: TranscriptContext): ToolSet {
	return Object.fromEntries(
		getCurrentTools(context.messages).map((definition) => [
			definition.name,
			tool({
				description: definition.description,
				inputSchema: jsonSchema(definition.parameters),
			}),
		]),
	);
}
