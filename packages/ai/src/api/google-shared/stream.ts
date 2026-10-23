import type { GoogleGenAI, GenerateContentParameters } from "@google/genai";
import { calculateCost } from "../../models.ts";
import type {
	AssistantMessage,
	Model,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
} from "../../types.ts";
import { formatProviderError, normalizeProviderError } from "../../utils/error-body.ts";
import { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { collapseSystemMessages } from "../../utils/transcript.ts";
import { failStreamTask } from "../lazy.ts";
import { mapStopReason, normalizeGoogleUsage, retryGoogleRequest } from "./response.ts";
import { isThinkingPart, retainThoughtSignature } from "./signatures.ts";
import type { GoogleApiType } from "./thinking.ts";

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

/** What one Google adapter supplies to `streamGoogle`: its names in errors, and its client and request for a context. */
export interface GoogleStreamAdapter {
	/** Adapter name in the custom-fetch error, such as "Google Vertex". */
	name: string;
	/** Stream name in the missing-finish-reason error, such as "Google". */
	streamName: string;
	prepare(context: TranscriptContext): { client: GoogleGenAI; params: GenerateContentParameters };
}

/**
 * Stream a `generateContentStream` response as assistant events. The Gemini API and Vertex share this; each adapter
 * supplies only its client and request parameters.
 */
export function streamGoogle<T extends GoogleApiType>(
	model: Model<T>,
	context: TranscriptContext,
	options: StreamOptions | undefined,
	adapter: GoogleStreamAdapter,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = collapseSystemMessages(context);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			if (options?.fetch && options.fetch !== globalThis.fetch) {
				throw new Error(`Custom fetch is not supported by the ${adapter.name} adapter`);
			}
			const { client, params: built } = adapter.prepare(normalizedContext);
			let params = built;
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			const googleStream = await retryGoogleRequest(() => client.models.generateContentStream(params), options);

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			for await (const chunk of googleStream) {
				await options?.onProviderStreamEvent?.(chunk, model);
				// @google/genai documents GenerateContentResponse.responseId (the same type on Gemini and Vertex) as an
				// output-only field identifying each response. Keep the first non-empty one from the stream.
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				if (candidate?.content?.parts) {
					for (const [partIndex, part] of candidate.content.parts.entries()) {
						if (part.text !== undefined || (part.thoughtSignature && !part.functionCall && !part.inlineData)) {
							const text = part.text ?? "";
							const isThinking = isThinkingPart(part);
							const existingSignature =
								currentBlock?.type === "thinking" ? currentBlock.thinkingSignature : currentBlock?.textSignature;
							// Parts within one chunk are distinct. Across chunks, unsigned deltas can continue a signed
							// block; a different signature or a signature-only ending marks another part.
							const signatureBoundary =
								(partIndex > 0 && Boolean(existingSignature || part.thoughtSignature)) ||
								Boolean(
									part.thoughtSignature &&
									(text === "" || (existingSignature && existingSignature !== part.thoughtSignature)),
								);
							if (
								!currentBlock ||
								signatureBoundary ||
								(isThinking && currentBlock.type !== "thinking") ||
								(!isThinking && currentBlock.type !== "text")
							) {
								if (currentBlock) {
									if (currentBlock.type === "text") {
										stream.push({
											type: "text_end",
											contentIndex: blocks.length - 1,
											content: currentBlock.text,
											partial: output,
										});
									} else {
										stream.push({
											type: "thinking_end",
											contentIndex: blockIndex(),
											content: currentBlock.thinking,
											partial: output,
										});
									}
								}
								if (isThinking) {
									currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
									output.content.push(currentBlock);
									stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
								} else {
									currentBlock = { type: "text", text: "" };
									output.content.push(currentBlock);
									stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
								}
							}
							if (currentBlock.type === "thinking") {
								currentBlock.thinking += text;
								currentBlock.thinkingSignature = retainThoughtSignature(
									currentBlock.thinkingSignature,
									part.thoughtSignature,
								);
								stream.push({
									type: "thinking_delta",
									contentIndex: blockIndex(),
									delta: text,
									partial: output,
								});
							} else {
								currentBlock.text += text;
								currentBlock.textSignature = retainThoughtSignature(currentBlock.textSignature, part.thoughtSignature);
								stream.push({
									type: "text_delta",
									contentIndex: blockIndex(),
									delta: text,
									partial: output,
								});
							}
						}

						if (part.functionCall) {
							if (currentBlock) {
								if (currentBlock.type === "text") {
									stream.push({
										type: "text_end",
										contentIndex: blockIndex(),
										content: currentBlock.text,
										partial: output,
									});
								} else {
									stream.push({
										type: "thinking_end",
										contentIndex: blockIndex(),
										content: currentBlock.thinking,
										partial: output,
									});
								}
								currentBlock = null;
							}

							// Generate unique ID if not provided or if it's a duplicate
							const providedId = part.functionCall.id;
							const needsNewId =
								!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
							const toolCallId = needsNewId
								? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
								: providedId;

							const toolCall: ToolCall = {
								type: "toolCall",
								id: toolCallId,
								name: part.functionCall.name || "",
								arguments: (part.functionCall.args as Record<string, any>) ?? {},
								...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
							};

							output.content.push(toolCall);
							stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
							stream.push({
								type: "toolcall_delta",
								contentIndex: blockIndex(),
								delta: JSON.stringify(toolCall.arguments),
								partial: output,
							});
							stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
						}
					}
				}

				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReason(candidate.finishReason);
					if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
				}

				if (chunk.usageMetadata) {
					output.usage = normalizeGoogleUsage(chunk.usageMetadata);
					calculateCost(model, output.usage);
				}
			}

			if (currentBlock) {
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error(`${adapter.streamName} stream ended without a finish reason`);
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				const errorMessage = output.rawStopReason
					? `Provider stopped with: ${output.rawStopReason}`
					: "An unknown error occurred";
				throw new Error(errorMessage);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			// Remove internal index property used during streaming
			for (const block of output.content) {
				if ("index" in block) {
					delete (block as { index?: number }).index;
				}
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})().catch((error: unknown) => failStreamTask(stream, model, error, options?.signal));

	return stream;
}
