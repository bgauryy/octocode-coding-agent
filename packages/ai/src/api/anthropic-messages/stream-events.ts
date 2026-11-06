import type {
	BetaInputTransformation,
	BetaRawMessageStreamEvent as RawMessageStreamEvent,
	BetaRefusalStopDetails as RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { calculateCost } from "../../models/model-helpers.ts";
import type {
	AssistantMessage,
	Model,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	UnsupportedContent,
} from "../../types.ts";
import { sumUsageTokens } from "../../utils/assistant-message.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { parseStreamingJson, parseStreamingJsonThrottled, parseToolCallArguments } from "../../utils/json-parse.ts";
import { appendAssistantMessageDiagnostic } from "../../utils/diagnostics.ts";
import { cacheMissDiagnostic } from "./cache-diagnostics.ts";
import { fromClaudeCodeName } from "./claude-code.ts";
import { providerOutputText } from "../provider-output.ts";
import { anthropicAnnotation, anthropicNativeFields, anthropicNativeOutput } from "./rich-content.ts";

type Block = (ThinkingContent | TextContent | UnsupportedContent | (ToolCall & { partialJson: string })) & {
	index: number;
};

/** Per-response state the stream loop shares with {@link handleAnthropicStreamEvent}. */
export interface AnthropicStreamState {
	model: Model<"anthropic-messages">;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	isOAuth: boolean;
	currentTools: Tool[];
	/** Model whose cost prices usage; a server-side fallback replaces it on `message_start`. */
	usageModel: Model<"anthropic-messages">;
	inputTransformations: BetaInputTransformation[] | undefined;
	/** Native tool input chunks belong to this stream, never to the persisted/display message. */
	nativeToolInputs?: Map<number, { type: string; fields: Record<string, unknown>; json: string }>;
}

/** Applies one Anthropic stream event to the partial message and emits the matching stream events. */
export function handleAnthropicStreamEvent(event: RawMessageStreamEvent, state: AnthropicStreamState): void {
	const { model, output, stream, isOAuth, currentTools } = state;
	const blocks = output.content as Block[];
	if (event.type === "message_start") {
		output.responseId = event.message.id;
		const cacheMiss = cacheMissDiagnostic(event.message.diagnostics);
		if (cacheMiss) appendAssistantMessageDiagnostic(output, cacheMiss);
		const transformations = event.message.input_transformations;
		if (Array.isArray(transformations)) state.inputTransformations = transformations;
		const responseModel = event.message.model;
		if (responseModel !== model.id) output.responseModel = responseModel;
		const fallbackCost =
			responseModel === model.id
				? undefined
				: model.compat?.allowedFallbackModels?.find(
						(fallback) => fallback.provider === model.provider && fallback.model === responseModel,
					)?.cost;
		state.usageModel = fallbackCost ? { ...model, id: responseModel, cost: fallbackCost } : model;
		// Capture initial token usage from message_start event
		// This ensures we have input token counts even if the stream is aborted early
		output.usage.input = event.message.usage.input_tokens || 0;
		output.usage.output = event.message.usage.output_tokens || 0;
		output.usage.cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
		output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens ?? 0;
		output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
		// Anthropic doesn't provide total_tokens, compute from components
		output.usage.totalTokens = sumUsageTokens(output.usage);
		calculateCost(state.usageModel, output.usage);
		// Output tokens are counted only in message_delta, so a stream dropped before it undercounts them.
		output.usage.lowerBound = true;
	} else if (event.type === "content_block_start") {
		if (event.content_block.type === "fallback") {
			if (output.content.length > 0) {
				throw new Error("Anthropic performed an unsupported mid-output model fallback");
			}
			return;
		}
		if (event.content_block.type === "text") {
			const block: Block = {
				type: "text",
				text: event.content_block.text ?? "",
				index: event.index,
				...(event.content_block.citations?.length
					? { annotations: event.content_block.citations.map(anthropicAnnotation) }
					: {}),
			};
			output.content.push(block);
			stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
		} else if (event.content_block.type === "thinking") {
			const block: Block = {
				type: "thinking",
				thinking: event.content_block.thinking ?? "",
				thinkingSignature: event.content_block.signature ?? "",
				index: event.index,
			};
			output.content.push(block);
			stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
		} else if (event.content_block.type === "redacted_thinking") {
			const block: Block = {
				type: "thinking",
				thinking: "[Reasoning redacted]",
				thinkingSignature: event.content_block.data,
				redacted: true,
				index: event.index,
			};
			output.content.push(block);
			stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
		} else if (event.content_block.type === "tool_use") {
			const block: Block = {
				type: "toolCall",
				id: event.content_block.id,
				name: isOAuth ? fromClaudeCodeName(event.content_block.name, currentTools) : event.content_block.name,
				arguments: (event.content_block.input as Record<string, any>) ?? {},
				partialJson: "",
				index: event.index,
			};
			output.content.push(block);
			stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
		} else {
			const native = anthropicNativeOutput(event.content_block);
			if (event.content_block.type === "server_tool_use" || event.content_block.type === "mcp_tool_use") {
				(state.nativeToolInputs ??= new Map()).set(event.index, {
					type: event.content_block.type,
					fields: anthropicNativeFields(event.content_block)!,
					json: "",
				});
			}
			output.content.push({
				...(native ?? {
					type: "unsupported",
					providerType: event.content_block.type,
					text: `Provider output: ${event.content_block.type}`,
				}),
				index: event.index,
			} as Block);
			stream.push({ type: "content_update", contentIndex: output.content.length - 1, partial: output });
		}
	} else if (event.type === "content_block_delta") {
		if (event.delta.type === "text_delta") {
			const index = blocks.findIndex((b) => b.index === event.index);
			const block = blocks[index];
			if (block && block.type === "text") {
				block.text += event.delta.text;
				stream.push({
					type: "text_delta",
					contentIndex: index,
					delta: event.delta.text,
					partial: output,
				});
			}
		} else if (event.delta.type === "thinking_delta") {
			const index = blocks.findIndex((b) => b.index === event.index);
			const block = blocks[index];
			if (block && block.type === "thinking") {
				block.thinking += event.delta.thinking;
				stream.push({
					type: "thinking_delta",
					contentIndex: index,
					delta: event.delta.thinking,
					partial: output,
				});
			}
		} else if (event.delta.type === "input_json_delta") {
			const index = blocks.findIndex((b) => b.index === event.index);
			const block = blocks[index];
			if (block && block.type === "toolCall") {
				block.partialJson += event.delta.partial_json;
				block.arguments = parseStreamingJsonThrottled(block.arguments, block.partialJson);
				stream.push({
					type: "toolcall_delta",
					contentIndex: index,
					delta: event.delta.partial_json,
					partial: output,
				});
			} else if (block?.type === "text") {
				const native = state.nativeToolInputs?.get(event.index);
				if (native) {
					native.json += event.delta.partial_json;
					native.fields.input = parseStreamingJsonThrottled(native.fields.input as object | undefined, native.json);
					block.text = providerOutputText(native.type, native.fields).text;
					stream.push({ type: "content_update", contentIndex: index, partial: output });
				}
			}
		} else if (event.delta.type === "compaction_delta" && event.delta.content) {
			const index = blocks.findIndex((b) => b.index === event.index);
			const block = blocks[index];
			if (block?.type === "unsupported" && block.providerType === "compaction") {
				blocks[index] = { type: "text", text: `Provider compaction:\n${event.delta.content}`, index: event.index };
			} else if (block?.type === "text") {
				block.text += event.delta.content;
			}
			if (block) stream.push({ type: "content_update", contentIndex: index, partial: output });
		} else if (event.delta.type === "citations_delta") {
			const index = blocks.findIndex((b) => b.index === event.index);
			const block = blocks[index];
			if (block?.type === "text") {
				(block.annotations ??= []).push(anthropicAnnotation(event.delta.citation));
				stream.push({ type: "content_update", contentIndex: index, partial: output });
			}
		} else if (event.delta.type === "signature_delta") {
			const index = blocks.findIndex((b) => b.index === event.index);
			const block = blocks[index];
			if (block && block.type === "thinking") {
				block.thinkingSignature = block.thinkingSignature || "";
				block.thinkingSignature += event.delta.signature;
			}
		}
	} else if (event.type === "content_block_stop") {
		const native = state.nativeToolInputs?.get(event.index);
		state.nativeToolInputs?.delete(event.index);
		const index = blocks.findIndex((b) => b.index === event.index);
		const block = blocks[index];
		if (native && block?.type === "text") {
			// Streaming previews are throttled; the finished input is rendered exactly.
			native.fields.input = parseStreamingJson(native.json);
			block.text = providerOutputText(native.type, native.fields).text;
		}
		if (block) {
			delete (block as any).index;
			if (block.type === "text") {
				stream.push({
					type: "text_end",
					contentIndex: index,
					content: block.text,
					partial: output,
				});
			} else if (block.type === "thinking") {
				stream.push({
					type: "thinking_end",
					contentIndex: index,
					content: block.thinking,
					partial: output,
				});
			} else if (block.type === "toolCall") {
				Object.assign(block, parseToolCallArguments(block.partialJson));
				// Finalize in-place and strip the scratch buffer so replay only
				// carries parsed arguments.
				delete (block as { partialJson?: string }).partialJson;
				stream.push({
					type: "toolcall_end",
					contentIndex: index,
					toolCall: block,
					partial: output,
				});
			}
		}
	} else if (event.type === "message_delta") {
		delete output.usage.lowerBound;
		const transformations = event.input_transformations;
		if (Array.isArray(transformations)) state.inputTransformations = transformations;
		if (event.delta.stop_reason) {
			output.rawStopReason = event.delta.stop_reason;
			const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
			output.stopReason = stopReasonResult.stopReason;
			if (stopReasonResult.errorMessage) {
				output.errorMessage = stopReasonResult.errorMessage;
			}
		}
		// Only update usage fields if present (not null).
		// Preserves input_tokens from message_start when proxies omit it in message_delta.
		if (event.usage) {
			if (event.usage.input_tokens != null) {
				output.usage.input = event.usage.input_tokens;
			}
			if (event.usage.output_tokens != null) {
				output.usage.output = event.usage.output_tokens;
			}
			if (event.usage.cache_read_input_tokens != null) {
				output.usage.cacheRead = event.usage.cache_read_input_tokens;
			}
			if (event.usage.cache_creation_input_tokens != null) {
				output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
			}
			// Vercel AI Gateway includes the TTL breakdown in deltas, though the SDK only types it on message_start.
			const cacheCreation = (
				event.usage as typeof event.usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }
			).cache_creation;
			if (cacheCreation?.ephemeral_1h_input_tokens != null) {
				output.usage.cacheWrite1h = cacheCreation.ephemeral_1h_input_tokens;
			}
			// Anthropic reports reasoning tokens as a subset of output tokens.
			const thinkingTokens = event.usage.output_tokens_details?.thinking_tokens;
			if (thinkingTokens != null) {
				output.usage.reasoning = thinkingTokens;
			}
		}
		// Anthropic doesn't provide total_tokens, compute from components
		output.usage.totalTokens = sumUsageTokens(output.usage);
		calculateCost(state.usageModel, output.usage);
	}
}

function mapStopReason(
	reason: string,
	stopDetails?: RefusalStopDetails | null,
): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "end_turn":
			return { stopReason: "stop" };
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal":
			return {
				stopReason: "error",
				errorMessage: stopDetails?.explanation || `The model refused to complete the request`,
			};
		case "pause_turn": // Stop is good enough -> resubmit
			return { stopReason: "stop" };
		case "stop_sequence":
			return { stopReason: "stop" }; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
