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
	ToolCall,
	UnsupportedContent,
} from "../../types.ts";
import { sumUsageTokens } from "../../utils/assistant-message.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { parseStreamingJson, parseStreamingJsonThrottled, parseToolCallArguments } from "../../utils/json-parse.ts";
import { appendAssistantMessageDiagnostic } from "../../utils/diagnostics.ts";
import { cacheMissDiagnostic } from "./cache-diagnostics.ts";
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
	/** Model whose cost prices usage; a server-side fallback replaces it on `message_start`. */
	usageModel: Model<"anthropic-messages">;
	inputTransformations: BetaInputTransformation[] | undefined;
	/** Native tool input chunks belong to this stream, never to the persisted/display message. */
	/** The request carried a 1h cache TTL marker; usage without a TTL breakdown then counts all writes as 1h. */
	longCacheRequested?: boolean;
	/** A usage event reported the per-TTL `cache_creation` breakdown, so it is authoritative. */
	cacheBreakdownSeen?: boolean;
	nativeToolInputs?: Map<number, { type: string; fields: Record<string, unknown>; json: string }>;
}

/**
 * True when every cache breakpoint in the request asks for the 1h TTL, so every write it caused is a 1h write. A
 * request that mixes 1h and 5m breakpoints (long instructions, short history) leaves the split unknown: the 5m rate
 * then stays as the lower bound.
 */
export function requestsLongCache(value: unknown): boolean {
	const ttls = new Set<string>();
	collectCacheTtls(value, ttls);
	return ttls.size === 1 && ttls.has("1h");
}

/** A breakpoint without `ttl` is Anthropic's default 5m. */
function collectCacheTtls(value: unknown, ttls: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectCacheTtls(item, ttls);
		return;
	}
	if (value === null || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	const control = record.cache_control;
	if (control !== null && typeof control === "object") {
		const ttl = (control as { ttl?: unknown }).ttl;
		ttls.add(typeof ttl === "string" ? ttl : "5m");
	}
	for (const [key, child] of Object.entries(record)) if (key !== "cache_control") collectCacheTtls(child, ttls);
}

/** Without a TTL breakdown the vendor aggregate is all we know; a 1h request means those writes were 1h. */
function assumeLongWrites(state: AnthropicStreamState): void {
	if (state.longCacheRequested && !state.cacheBreakdownSeen)
		state.output.usage.cacheWrite1h = state.output.usage.cacheWrite;
}

/** Applies one Anthropic stream event to the partial message and emits the matching stream events. */
export function handleAnthropicStreamEvent(event: RawMessageStreamEvent, state: AnthropicStreamState): void {
	const { model, output, stream } = state;
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
		const breakdown = event.message.usage.cache_creation;
		state.cacheBreakdownSeen = breakdown != null;
		output.usage.cacheWrite1h = breakdown?.ephemeral_1h_input_tokens ?? 0;
		assumeLongWrites(state);
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
				name: event.content_block.name,
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
			// Counts are cumulative: a proxy's zero must not replace what message_start reported.
			if (event.usage.input_tokens != null && !(event.usage.input_tokens === 0 && output.usage.input > 0)) {
				output.usage.input = event.usage.input_tokens;
			}
			if (event.usage.output_tokens != null) {
				output.usage.output = event.usage.output_tokens;
			}
			if (
				event.usage.cache_read_input_tokens != null &&
				!(event.usage.cache_read_input_tokens === 0 && output.usage.cacheRead > 0)
			) {
				output.usage.cacheRead = event.usage.cache_read_input_tokens;
			}
			if (
				event.usage.cache_creation_input_tokens != null &&
				!(event.usage.cache_creation_input_tokens === 0 && output.usage.cacheWrite > 0)
			) {
				// A breakdown reported for a different aggregate no longer describes these writes.
				if (event.usage.cache_creation_input_tokens !== output.usage.cacheWrite) state.cacheBreakdownSeen = false;
				output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
			}
			// Vercel AI Gateway includes the TTL breakdown in deltas, though the SDK only types it on message_start.
			const cacheCreation = (
				event.usage as typeof event.usage & { cache_creation?: { ephemeral_1h_input_tokens?: number } }
			).cache_creation;
			if (cacheCreation?.ephemeral_1h_input_tokens != null) {
				state.cacheBreakdownSeen = true;
				output.usage.cacheWrite1h = cacheCreation.ephemeral_1h_input_tokens;
			}
			assumeLongWrites(state);
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
		case "pause_turn":
			// Only server tools (web search, code execution) pause a turn, and no request enables them. A proxy
			// that reports it ends the turn with the content received; `rawStopReason` keeps the original value.
			return { stopReason: "stop" };
		case "stop_sequence":
			return { stopReason: "stop" }; // We don't supply stop sequences, so this should never happen
		case "model_context_window_exceeded":
			return {
				stopReason: "error",
				errorMessage: "model_context_window_exceeded: the request reached the model's context window",
			};
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return { stopReason: "error", errorMessage: "Provider stopped with: sensitive" };
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
