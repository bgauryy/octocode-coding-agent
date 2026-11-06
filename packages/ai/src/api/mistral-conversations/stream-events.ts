import { calculateCost } from "../../models/model-helpers.ts";
import type {
	AssistantMessage,
	Model,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../../types.ts";
import { sumUsageTokens } from "../../utils/assistant-message.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { parseStreamingJsonThrottled, parseToolCallArguments } from "../../utils/json-parse.ts";
import { sanitizeSurrogates } from "../../utils/sanitize-unicode.ts";
import { deriveMistralToolCallId } from "./tool-call-ids.ts";
import type { MistralCompletionEvent } from "./types.ts";

function getMistralCachedPromptTokens(usage: unknown, promptTokens: number): number {
	const rawUsage = usage as {
		promptTokensDetails?: { cachedTokens?: unknown } | null;
		prompt_tokens_details?: { cached_tokens?: unknown } | null;
		promptTokenDetails?: { cachedTokens?: unknown } | null;
		prompt_token_details?: { cached_tokens?: unknown } | null;
		numCachedTokens?: unknown;
		num_cached_tokens?: unknown;
	};
	const rawCachedTokens =
		rawUsage.promptTokensDetails?.cachedTokens ??
		rawUsage.prompt_tokens_details?.cached_tokens ??
		rawUsage.promptTokenDetails?.cachedTokens ??
		rawUsage.prompt_token_details?.cached_tokens ??
		rawUsage.numCachedTokens ??
		rawUsage.num_cached_tokens ??
		0;
	const cachedTokens = typeof rawCachedTokens === "number" && Number.isFinite(rawCachedTokens) ? rawCachedTokens : 0;
	return Math.min(promptTokens, Math.max(0, cachedTokens));
}

export async function consumeChatStream(
	model: Model<"mistral-conversations">,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	mistralStream: AsyncIterable<MistralCompletionEvent>,
	onProviderStreamEvent: StreamOptions["onProviderStreamEvent"],
): Promise<void> {
	let currentBlock: TextContent | ThinkingContent | null = null;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;
	const toolBlocksByKey = new Map<string | number, number>();

	const finishCurrentBlock = (block?: typeof currentBlock) => {
		if (!block) return;
		if (block.type === "text") {
			stream.push({
				type: "text_end",
				contentIndex: blockIndex(),
				content: block.text,
				partial: output,
			});
			return;
		}
		if (block.type === "thinking") {
			stream.push({
				type: "thinking_end",
				contentIndex: blockIndex(),
				content: block.thinking,
				partial: output,
			});
		}
	};

	// Usage arrives in the last chunk, so a stream dropped before it has recorded nothing of what was generated.
	output.usage.lowerBound = true;
	for await (const event of mistralStream) {
		const chunk = event.data;
		await onProviderStreamEvent?.(chunk, model);
		// Mistral's streamed CompletionChunk carries an id field. Keep the first non-empty one,
		// mirroring how OpenAI-style streaming exposes a stable response identifier per stream.
		output.responseId ||= chunk.id;

		if (chunk.usage) {
			const promptTokens = chunk.usage.prompt_tokens ?? 0;
			const cachedPromptTokens = getMistralCachedPromptTokens(chunk.usage, promptTokens);

			output.usage.input = Math.max(0, promptTokens - cachedPromptTokens);
			output.usage.output = chunk.usage.completion_tokens ?? 0;
			output.usage.cacheRead = cachedPromptTokens;
			output.usage.cacheWrite = 0;
			output.usage.totalTokens = sumUsageTokens(output.usage, chunk.usage.total_tokens);
			calculateCost(model, output.usage);
			delete output.usage.lowerBound;
		}

		const choice = chunk.choices[0];
		if (!choice) continue;

		if (choice.finish_reason) {
			output.rawStopReason = choice.finish_reason;
			const stopReasonResult = mapChatStopReason(choice.finish_reason);
			output.stopReason = stopReasonResult.stopReason;
			if (stopReasonResult.errorMessage) {
				output.errorMessage = stopReasonResult.errorMessage;
			}
		}

		const delta = choice.delta;
		if (delta.content !== null && delta.content !== undefined) {
			const contentItems = typeof delta.content === "string" ? [delta.content] : delta.content;
			for (const item of contentItems) {
				if (typeof item === "string" || item.type === "text") {
					const textDelta = sanitizeSurrogates(typeof item === "string" ? item : (item.text ?? ""));
					// GLM models on Mistral send empty content deltas around thinking and tool calls.
					// Opening a block for them splits thinking into multiple blocks, which Mistral rejects on replay.
					if (!textDelta) continue;
					if (!currentBlock || currentBlock.type !== "text") {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: "text", text: "" };
						output.content.push(currentBlock);
						stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
					}
					currentBlock.text += textDelta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: textDelta,
						partial: output,
					});
					continue;
				}

				if (item.type === "thinking") {
					const deltaText = (item.thinking ?? [])
						.map((part) => part.text ?? "")
						.filter((text) => text.length > 0)
						.join("");
					const thinkingDelta = sanitizeSurrogates(deltaText);
					if (!thinkingDelta) continue;
					if (!currentBlock || currentBlock.type !== "thinking") {
						finishCurrentBlock(currentBlock);
						currentBlock = { type: "thinking", thinking: "" };
						output.content.push(currentBlock);
						stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
					}
					currentBlock.thinking += thinkingDelta;
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: thinkingDelta,
						partial: output,
					});
					continue;
				}
				finishCurrentBlock(currentBlock);
				currentBlock = null;
				const imageUrl = item.imageUrl ?? (typeof item.image_url === "string" ? item.image_url : item.image_url?.url);
				const embedded = imageUrl?.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
				output.content.push(
					embedded
						? { type: "image", mimeType: embedded[1], data: embedded[2] }
						: imageUrl
							? { type: "resource", uri: imageUrl, name: "Generated image" }
							: { type: "unsupported", providerType: item.type, text: item.text ?? `Provider output: ${item.type}` },
				);
				stream.push({ type: "content_update", contentIndex: blockIndex(), partial: output });
			}
		}

		const toolCalls = delta.tool_calls ?? [];
		for (const toolCall of toolCalls) {
			if (currentBlock) {
				finishCurrentBlock(currentBlock);
				currentBlock = null;
			}
			const callId =
				toolCall.id && toolCall.id !== "null"
					? toolCall.id
					: deriveMistralToolCallId(`toolcall:${toolCall.index ?? 0}`, 0);
			const key = toolCall.index ?? callId;
			const existingIndex = toolBlocksByKey.get(key);
			let block: (ToolCall & { partialArgs?: string }) | undefined;

			if (existingIndex !== undefined) {
				const existing = output.content[existingIndex];
				if (existing?.type === "toolCall") {
					block = existing;
				}
			}

			if (!block) {
				block = {
					type: "toolCall",
					id: callId,
					name: toolCall.function.name,
					arguments: {},
					partialArgs: "",
				};
				output.content.push(block);
				toolBlocksByKey.set(key, output.content.length - 1);
				stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
			}

			const argsDelta =
				typeof toolCall.function.arguments === "string"
					? toolCall.function.arguments
					: JSON.stringify(toolCall.function.arguments || {});
			block.partialArgs = (block.partialArgs || "") + argsDelta;
			block.arguments = parseStreamingJsonThrottled<ToolCall["arguments"]>(block.arguments, block.partialArgs);
			stream.push({
				type: "toolcall_delta",
				contentIndex: toolBlocksByKey.get(key)!,
				delta: argsDelta,
				partial: output,
			});
		}
	}

	// A stream that ended properly is the whole count, even without a usage chunk.
	delete output.usage.lowerBound;
	finishCurrentBlock(currentBlock);
	for (const index of toolBlocksByKey.values()) {
		const block = output.content[index];
		if (block.type !== "toolCall") continue;
		const toolBlock = block as ToolCall & { partialArgs?: string };
		Object.assign(toolBlock, parseToolCallArguments(toolBlock.partialArgs));
		// Finalize in-place and strip the scratch buffer so replay only
		// carries parsed arguments.
		delete toolBlock.partialArgs;
		stream.push({
			type: "toolcall_end",
			contentIndex: index,
			toolCall: toolBlock,
			partial: output,
		});
	}
}

function mapChatStopReason(reason: string | null): { stopReason: StopReason; errorMessage?: string } {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
			return { stopReason: "stop" };
		case "length":
		case "model_length":
			return { stopReason: "length" };
		case "tool_calls":
			return { stopReason: "toolUse" };
		case "error":
			// Mistral reports transient server failures this way; "server error" makes the message retryable.
			return { stopReason: "error", errorMessage: "Provider stopped with: error (server error)" };
		default:
			return { stopReason: "error", errorMessage: `Provider stopped with: ${reason}` };
	}
}
