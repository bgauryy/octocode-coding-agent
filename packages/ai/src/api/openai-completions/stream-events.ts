import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type { AssistantMessage, Model, TextContent, ThinkingContent, ToolCall } from "../../types.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { parseStreamingJson, parseToolCallArguments } from "../../utils/json-parse.ts";
import { appendGrammarToolInputJsonDelta, type GrammarToolInputJsonBuffer } from "../constrained-sampling.ts";
import {
	appendOpenAIReasoningDetail,
	applyStreamedReasoningDetails,
	isOpenAIReasoningDetail,
	type StreamedReasoningDetails,
} from "./reasoning-details.ts";
import { getCompat } from "./compat.ts";
import { mapStopReason, parseChunkUsage } from "./usage.ts";

interface StreamingToolCallBlock extends ToolCall {
	partialArgs?: string;
	customInput?: {
		property: string;
		jsonBuffer: GrammarToolInputJsonBuffer;
	};
	streamIndex?: number;
}
type StreamingBlock = TextContent | ThinkingContent | StreamingToolCallBlock;
type StreamingToolCallDelta = {
	index?: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
	custom?: { name?: string; input?: string };
};

/** Maps Chat Completions stream chunks onto one assistant message and its stream events. */
interface CompletionsChunkProcessor {
	/** Applies one chunk object to the output message and pushes its events. */
	processChunk(chunk: ChatCompletionChunk): void;
	/** Finalizes every content block in order. */
	finishBlocks(): void;
	/** Whether any chunk carried `finish_reason`. */
	hasFinishReason(): boolean;
}

export function createCompletionsChunkProcessor(
	model: Model<"openai-completions">,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	grammarToolInputProperties: ReadonlyMap<string, string>,
	streamedReasoningDetails: StreamedReasoningDetails,
): CompletionsChunkProcessor {
	const { reasoningReplayField } = getCompat(model);
	let textBlock: TextContent | null = null;
	let thinkingBlock: ThinkingContent | null = null;
	let hasFinishReason = false;
	const toolCallBlocksByIndex = new Map<number, StreamingToolCallBlock>();
	const toolCallBlocksById = new Map<string, StreamingToolCallBlock>();
	const blocks = output.content as StreamingBlock[];
	const getContentIndex = (block: StreamingBlock) => blocks.indexOf(block);
	const getCustomToolCallInput = (block: StreamingToolCallBlock): string => {
		const property = block.customInput?.property;
		if (property === undefined) return "";
		const value = block.arguments[property];
		return typeof value === "string" ? value : "";
	};
	const appendCustomToolCallInput = (
		block: StreamingToolCallBlock,
		nextInput: string,
		close: boolean,
	): string | undefined => {
		const customInput = block.customInput;
		if (!customInput) return undefined;
		const delta = appendGrammarToolInputJsonDelta(customInput.jsonBuffer, customInput.property, nextInput, close);
		block.arguments = { [customInput.property]: nextInput };
		return delta;
	};
	const finishBlock = (block: StreamingBlock) => {
		const contentIndex = getContentIndex(block);
		if (contentIndex === -1) {
			return;
		}
		if (block.type === "text") {
			stream.push({
				type: "text_end",
				contentIndex,
				content: block.text,
				partial: output,
			});
		} else if (block.type === "thinking") {
			applyStreamedReasoningDetails(block, streamedReasoningDetails);
			stream.push({
				type: "thinking_end",
				contentIndex,
				content: block.thinking,
				partial: output,
			});
		} else if (block.type === "toolCall") {
			if (block.customInput) {
				const delta = appendCustomToolCallInput(block, getCustomToolCallInput(block), true);
				if (delta !== undefined) {
					stream.push({
						type: "toolcall_delta",
						contentIndex,
						delta,
						partial: output,
					});
				}
			} else {
				Object.assign(block, parseToolCallArguments(block.partialArgs));
			}
			// Finalize in-place and strip the scratch buffers so replay only
			// carries parsed arguments.
			delete block.partialArgs;
			delete block.customInput;
			delete block.streamIndex;
			stream.push({
				type: "toolcall_end",
				contentIndex,
				toolCall: block,
				partial: output,
			});
		}
	};
	const ensureTextBlock = () => {
		if (!textBlock) {
			textBlock = { type: "text", text: "" };
			blocks.push(textBlock);
			stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
		}
		return textBlock;
	};
	const ensureThinkingBlock = (thinkingSignature: string) => {
		if (!thinkingBlock) {
			thinkingBlock = {
				type: "thinking",
				thinking: "",
				thinkingSignature,
			};
			blocks.push(thinkingBlock);
			stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
		}
		return thinkingBlock;
	};
	const ensureToolCallBlock = (toolCall: StreamingToolCallDelta) => {
		const streamIndex = typeof toolCall.index === "number" ? toolCall.index : undefined;
		const name = toolCall.function?.name ?? toolCall.custom?.name ?? "";
		let block = streamIndex !== undefined ? toolCallBlocksByIndex.get(streamIndex) : undefined;
		if (!block && toolCall.id) {
			block = toolCallBlocksById.get(toolCall.id);
		}
		if (!block) {
			// Note: the "input" fallback here should/must not be taken.  in case the LLM makes up
			// a tool we don't knwo about, we at least have a place to stash our stuff.
			const customInputProperty =
				toolCall.custom && !toolCall.function ? (grammarToolInputProperties.get(name) ?? "input") : undefined;
			const hasCustomInput = customInputProperty !== undefined;
			block = {
				type: "toolCall",
				id: toolCall.id || "",
				name,
				arguments: hasCustomInput ? { [customInputProperty]: "" } : {},
				partialArgs: hasCustomInput ? undefined : "",
				customInput: hasCustomInput
					? { property: customInputProperty, jsonBuffer: { input: "", started: false, closed: false } }
					: undefined,
				streamIndex,
			};
			if (streamIndex !== undefined) {
				toolCallBlocksByIndex.set(streamIndex, block);
			}
			if (toolCall.id) {
				toolCallBlocksById.set(toolCall.id, block);
			}
			blocks.push(block);
			stream.push({
				type: "toolcall_start",
				contentIndex: getContentIndex(block),
				partial: output,
			});
		}
		if (streamIndex !== undefined && block.streamIndex === undefined) {
			block.streamIndex = streamIndex;
			toolCallBlocksByIndex.set(streamIndex, block);
		}
		if (toolCall.id) {
			toolCallBlocksById.set(toolCall.id, block);
		}
		if (!block.name && name) {
			block.name = name;
		}
		if (toolCall.custom && !toolCall.function && !block.customInput) {
			const customInputProperty = grammarToolInputProperties.get(block.name) ?? "input";
			block.arguments = { [customInputProperty]: "" };
			block.customInput = {
				property: customInputProperty,
				jsonBuffer: { input: "", started: false, closed: false },
			};
			delete block.partialArgs;
		}
		return block;
	};

	const processChunk = (chunk: ChatCompletionChunk): void => {
		// OpenAI documents ChatCompletionChunk.id as the unique chat completion identifier,
		// and each chunk in a streamed completion carries the same id.
		output.responseId ||= chunk.id;
		if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
			output.responseModel ||= chunk.model;
		}
		if (chunk.usage) {
			output.usage = parseChunkUsage(chunk.usage, model);
		}

		const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
		if (!choice) return;

		// Fallback: some providers (e.g., Moonshot) return usage
		// in choice.usage instead of the standard chunk.usage
		if (!chunk.usage && (choice as any).usage) {
			output.usage = parseChunkUsage((choice as any).usage, model);
		}

		if (choice.finish_reason) {
			output.rawStopReason = choice.finish_reason;
			const finishReasonResult = mapStopReason(choice.finish_reason);
			output.stopReason = finishReasonResult.stopReason;
			if (finishReasonResult.errorMessage) {
				output.errorMessage = finishReasonResult.errorMessage;
			}
			hasFinishReason = true;
		}

		if (choice.delta) {
			// Handle reasoning before content: some proxies (e.g. LiteLLM) aggregate reasoning and
			// answer into one delta, and the thinking block must precede the text block.
			// Some endpoints return reasoning in reasoning_content (llama.cpp),
			// or reasoning (other openai compatible endpoints)
			// Use the first non-empty reasoning field to avoid duplication
			// (e.g., chutes.ai returns both reasoning_content and reasoning with same content)
			const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
			const deltaFields = choice.delta as Record<string, unknown>;
			let foundReasoningField: string | null = null;
			for (const field of reasoningFields) {
				const value = deltaFields[field];
				if (typeof value === "string" && value.length > 0) {
					foundReasoningField = field;
					break;
				}
			}

			if (foundReasoningField) {
				const delta = deltaFields[foundReasoningField];
				if (typeof delta === "string" && delta.length > 0) {
					const thinkingSignature =
						foundReasoningField === "reasoning" && reasoningReplayField ? reasoningReplayField : foundReasoningField;
					const block = ensureThinkingBlock(thinkingSignature);
					block.thinking += delta;
					stream.push({
						type: "thinking_delta",
						contentIndex: getContentIndex(block),
						delta,
						partial: output,
					});
				}
			}

			const reasoningDetails = (choice.delta as { reasoning_details?: unknown }).reasoning_details;
			if (Array.isArray(reasoningDetails)) {
				for (const detail of reasoningDetails) {
					if (!isOpenAIReasoningDetail(detail)) continue;
					ensureThinkingBlock("");
					streamedReasoningDetails.details ??= [];
					// Keep provider replay data in the existing signature slot. OpenRouter streams
					// reasoning_details as deltas: consecutive text/summary deltas are merged into
					// logical entries, while encrypted entries remain opaque and discrete.
					appendOpenAIReasoningDetail(streamedReasoningDetails.details, detail);
				}
			}

			const visibleDelta = (choice.delta.content ?? "") + (choice.delta.refusal ?? "");
			if (visibleDelta.length > 0) {
				const block = ensureTextBlock();
				block.text += visibleDelta;
				stream.push({
					type: "text_delta",
					contentIndex: getContentIndex(block),
					delta: visibleDelta,
					partial: output,
				});
			}

			if (choice?.delta?.tool_calls) {
				for (const toolCall of choice.delta.tool_calls as StreamingToolCallDelta[]) {
					const block = ensureToolCallBlock(toolCall);
					if (!block.id && toolCall.id) {
						block.id = toolCall.id;
						toolCallBlocksById.set(toolCall.id, block);
					}
					const name = toolCall.function?.name ?? toolCall.custom?.name;
					if (!block.name && name) {
						block.name = name;
					}

					let delta = "";
					if (toolCall.function?.arguments) {
						delta = toolCall.function.arguments;
						block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
						block.arguments = parseStreamingJson(block.partialArgs);
					} else if (toolCall.custom?.input) {
						const nextInput = getCustomToolCallInput(block) + toolCall.custom.input;
						delta = appendCustomToolCallInput(block, nextInput, false) ?? "";
					}
					stream.push({
						type: "toolcall_delta",
						contentIndex: getContentIndex(block),
						delta,
						partial: output,
					});
				}
			}
		}
	};

	return {
		processChunk,
		finishBlocks: () => {
			for (const block of blocks) {
				finishBlock(block);
			}
		},
		hasFinishReason: () => hasFinishReason,
	};
}
