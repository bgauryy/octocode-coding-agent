import {
	StopReason as BedrockStopReason,
	CacheTTL,
	type ContentBlockDeltaEvent,
	type ContentBlockStartEvent,
	type ContentBlockStopEvent,
	type ConverseStreamMetadataEvent,
} from "@aws-sdk/client-bedrock-runtime";
import { calculateCost } from "../../models/model-helpers.ts";
import type { AssistantMessage, Model, StopReason } from "../../types.ts";
import { sumUsageTokens } from "../../utils/assistant-message.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { parseStreamingJsonThrottled, parseToolCallArguments } from "../../utils/json-parse.ts";
import { type Block, REDACTED_THINKING_PLACEHOLDER } from "./types.ts";
import { bedrockAnnotation } from "./rich-content.ts";
import { outputFields, providerOutputText } from "../provider-output.ts";

export function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = event.contentBlockIndex!;
	const start = event.start;

	if (start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: start.toolUse.toolUseId || "",
			name: start.toolUse.name || "",
			arguments: {},
			partialJson: "",
			index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	} else if (start?.image) {
		output.content.push({ type: "image", data: "", mimeType: `image/${start.image.format ?? "png"}`, index } as Block);
		stream.push({ type: "content_update", contentIndex: blocks.length - 1, partial: output });
	} else if (start?.toolResult) {
		output.content.push({
			...providerOutputText("toolResult", outputFields(start.toolResult, ["toolUseId", "type", "status"])),
			index,
		} as Block);
		stream.push({ type: "content_update", contentIndex: blocks.length - 1, partial: output });
	} else if (start) {
		const providerType = start.$unknown?.[0] ?? "toolResult";
		output.content.push({
			type: "unsupported",
			providerType,
			text: `Provider output: ${providerType}`,
			index,
		} as Block);
		stream.push({ type: "content_update", contentIndex: blocks.length - 1, partial: output });
	}
}

export function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex!;
	const delta = event.delta;
	let index = blocks.findIndex((b) => b.index === contentBlockIndex);
	let block = blocks[index];

	if (delta?.text !== undefined) {
		// If no text block exists yet, create one, as `handleContentBlockStart` is not sent for text blocks
		if (!block) {
			const newBlock: Block = { type: "text", text: "", index: contentBlockIndex };
			output.content.push(newBlock);
			index = blocks.length - 1;
			block = blocks[index];
			stream.push({ type: "text_start", contentIndex: index, partial: output });
		}
		if (block.type === "text") {
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
		}
	} else if (delta?.citation) {
		if (!block) {
			block = { type: "text", text: "", index: contentBlockIndex };
			output.content.push(block);
			index = blocks.length - 1;
		}
		if (block.type === "text") {
			(block.annotations ??= []).push(bedrockAnnotation(delta.citation));
			stream.push({ type: "content_update", contentIndex: index, partial: output });
		}
	} else if (delta?.image) {
		if (block?.type === "image" && delta.image.source?.bytes) {
			(block.imageChunks ??= []).push(delta.image.source.bytes);
			block.data = bytesToBase64(block.imageChunks);
		} else if (delta.image.source?.s3Location?.uri) {
			block = { type: "resource", uri: delta.image.source.s3Location.uri, index: contentBlockIndex };
		} else if (delta.image.error) {
			block = {
				type: "unsupported",
				providerType: "image",
				text: `Image output failed: ${delta.image.error.message ?? "Provider error"}`,
				index: contentBlockIndex,
			};
		}
		if (block) {
			if (index < 0) index = output.content.length;
			output.content[index] = block;
			stream.push({ type: "content_update", contentIndex: index, partial: output });
		}
	} else if (delta?.toolResult) {
		if (!block) {
			block = { type: "text", text: "", index: contentBlockIndex };
			output.content.push(block);
			index = blocks.length - 1;
		}
		if (block.type === "text") {
			for (const part of delta.toolResult) {
				block.text +=
					part.text ??
					`\n${providerOutputText("toolResult", part.json !== undefined ? { result: part.json } : { type: part.$unknown?.[0] }).text}`;
			}
			stream.push({ type: "content_update", contentIndex: index, partial: output });
		}
	} else if (delta?.$unknown && !block) {
		output.content.push({
			type: "unsupported",
			providerType: delta.$unknown[0],
			text: `Provider output: ${delta.$unknown[0]}`,
			index: contentBlockIndex,
		} as Block);
		stream.push({ type: "content_update", contentIndex: blocks.length - 1, partial: output });
	} else if (delta?.toolUse && block?.type === "toolCall") {
		block.partialJson = (block.partialJson || "") + (delta.toolUse.input || "");
		block.arguments = parseStreamingJsonThrottled(block.arguments, block.partialJson);
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input || "", partial: output });
	} else if (delta?.reasoningContent) {
		let thinkingBlock = block;
		let thinkingIndex = index;

		if (!thinkingBlock) {
			const newBlock: Block = { type: "thinking", thinking: "", thinkingSignature: "", index: contentBlockIndex };
			output.content.push(newBlock);
			thinkingIndex = blocks.length - 1;
			thinkingBlock = blocks[thinkingIndex];
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
		}

		if (thinkingBlock?.type === "thinking") {
			if (delta.reasoningContent.text) {
				thinkingBlock.thinking += delta.reasoningContent.text;
				stream.push({
					type: "thinking_delta",
					contentIndex: thinkingIndex,
					delta: delta.reasoningContent.text,
					partial: output,
				});
			}
			// `thinkingSignature` holds either an Anthropic signature or an opaque redacted
			// payload, never both: mixing them would corrupt whichever arrived first.
			if (delta.reasoningContent.signature && !thinkingBlock.redacted) {
				thinkingBlock.thinkingSignature = (thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
			}
			if (delta.reasoningContent.redactedContent?.length) {
				// Encrypted reasoning from non-Anthropic models on Bedrock (e.g. OpenAI GPT-5.6).
				// The payload is opaque, so keep it verbatim in `thinkingSignature` the way the
				// Anthropic path stores redacted thinking, and replay it on the next turn.
				if (!thinkingBlock.redacted) {
					thinkingBlock.redacted = true;
					thinkingBlock.thinkingSignature = "";
					thinkingBlock.thinking += REDACTED_THINKING_PLACEHOLDER;
					stream.push({
						type: "thinking_delta",
						contentIndex: thinkingIndex,
						delta: REDACTED_THINKING_PLACEHOLDER,
						partial: output,
					});
				}
				thinkingBlock.redactedChunks ??= [];
				thinkingBlock.redactedChunks.push(delta.reasoningContent.redactedContent);
			}
		}
	}
}

/**
 * Encodes buffered encrypted reasoning into `thinkingSignature` and drops the scratch
 * buffer, which must never reach a persisted message: `Uint8Array` serializes to an
 * index-keyed object roughly ten times the size of the base64 payload.
 */
function flushRedactedContent(block: Block): void {
	if (block.type !== "thinking" || !block.redactedChunks) return;
	block.thinkingSignature = bytesToBase64(block.redactedChunks);
	delete block.redactedChunks;
}

/**
 * Strips every streaming scratch field. Runs from the terminal paths as well as
 * `contentBlockStop`, because a stream can settle without stopping each block.
 */
export function finalizeStreamingBlock(block: Block): void {
	delete block.index;
	// partialJson is only a streaming scratch buffer; never persist it.
	delete block.partialJson;
	delete block.imageChunks;
	flushRedactedContent(block);
}

export function handleMetadata(
	event: ConverseStreamMetadataEvent,
	model: Model<"bedrock-converse-stream">,
	output: AssistantMessage,
): void {
	if (event.usage) {
		output.usage.input = event.usage.inputTokens ?? 0;
		output.usage.output = event.usage.outputTokens ?? 0;
		output.usage.cacheRead = event.usage.cacheReadInputTokens ?? 0;
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens ?? 0;
		output.usage.cacheWrite1h = event.usage.cacheDetails?.reduce(
			(total, detail) => total + (detail.ttl === CacheTTL.ONE_HOUR ? (detail.inputTokens ?? 0) : 0),
			0,
		);
		// Bedrock's total includes cache reads and writes; the fallback counts them the same way.
		output.usage.totalTokens = sumUsageTokens(output.usage, event.usage.totalTokens);
		calculateCost(model, output.usage);
	}
}

export function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex((b) => b.index === event.contentBlockIndex);
	const block = blocks[index];
	if (!block) return;
	delete block.index;
	delete block.imageChunks;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			flushRedactedContent(block);
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			Object.assign(block, parseToolCallArguments(block.partialJson));
			// Finalize in-place and strip the scratch buffer so replay only
			// carries parsed arguments.
			delete (block as Block).partialJson;
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			break;
		// The Bedrock stream opens only text, thinking and tool call blocks.
		case "image":
		case "media":
		case "resource":
		case "unsupported":
			break;
	}
}

export function mapStopReason(reason: string | undefined): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case BedrockStopReason.END_TURN:
		case BedrockStopReason.STOP_SEQUENCE:
			return { stopReason: "stop" };
		case BedrockStopReason.MAX_TOKENS:
		case BedrockStopReason.MODEL_CONTEXT_WINDOW_EXCEEDED:
			return { stopReason: "length" };
		case BedrockStopReason.TOOL_USE:
			return { stopReason: "toolUse" };
		default:
			return reason
				? { stopReason: "error", errorMessage: `Provider stopped with: ${reason}` }
				: { stopReason: "error" };
	}
}

function bytesToBase64(chunks: Uint8Array[]): string {
	// Encrypted reasoning runs to tens of KB, so build the binary string in slices
	// rather than one concatenation per byte. The window stays under the engine's
	// argument-count limit for spread calls.
	const WINDOW = 0x8000;
	let binary = "";
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i += WINDOW) {
			binary += String.fromCharCode(...chunk.subarray(i, i + WINDOW));
		}
	}
	return btoa(binary);
}
