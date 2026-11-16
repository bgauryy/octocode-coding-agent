import type { LanguageModelUsage, ProviderMetadata, TextStreamPart, ToolSet } from "ai";
import type { Api, AssistantMessage, Model, TextContent, ThinkingContent, ToolCall, Usage } from "../../types.ts";
import { calculateCost } from "../../models/model-helpers.ts";
import { createUsage } from "../../utils/assistant-message.ts";
import type { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { parseStreamingJsonThrottled, parseToolCallArguments } from "../../utils/json-parse.ts";

type Block = TextContent | ThinkingContent | ToolCall;

export function sdkUsage(usage: LanguageModelUsage): Usage {
	const cacheRead = usage.inputTokenDetails.cacheReadTokens ?? 0;
	const cacheWrite = usage.inputTokenDetails.cacheWriteTokens ?? 0;
	const result = createUsage({
		input: usage.inputTokenDetails.noCacheTokens ?? Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite),
		output: usage.outputTokens ?? 0,
		cacheRead,
		cacheWrite,
		reasoning: usage.outputTokenDetails.reasoningTokens,
		totalTokens: usage.totalTokens,
	});
	if (usage.inputTokens === undefined || usage.outputTokens === undefined) result.lowerBound = true;
	return result;
}

export function applySdkUsage(output: AssistantMessage, usage: LanguageModelUsage, model: Model<Api>): void {
	output.usage = sdkUsage(usage);
	calculateCost(model, output.usage);
}

function metadata(block: Block, value: ProviderMetadata | undefined): void {
	const google = value?.google ?? value?.vertex;
	const signature = google?.thoughtSignature;
	if (typeof signature === "string") {
		if (block.type === "thinking") block.thinkingSignature = signature;
		else if (block.type === "text") block.textSignature = signature;
		else block.thoughtSignature = signature;
	}
	const openai = value?.openai ?? value?.azure;
	if (typeof openai?.itemId === "string") {
		if (block.type === "text")
			block.textSignature = JSON.stringify({
				v: 1,
				id: openai.itemId,
				...(openai.phase === "commentary" || openai.phase === "final_answer" ? { phase: openai.phase } : {}),
			});
		else if (block.type === "toolCall" && !block.id.includes("|")) block.id = `${block.id}|${openai.itemId}`;
		else if (block.type === "thinking")
			block.thinkingSignature = JSON.stringify({
				type: "reasoning",
				id: openai.itemId,
				summary: block.thinking ? [{ type: "summary_text", text: block.thinking }] : [],
				encrypted_content: openai.reasoningEncryptedContent ?? null,
			});
	}
	const anthropicSignature = value?.anthropic?.signature;
	if (block.type === "thinking" && typeof anthropicSignature === "string") {
		block.thinkingSignature = (block.thinkingSignature ?? "") + anthropicSignature;
	}
}

export function sdkEventProcessor(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	emptyToolInputs?: Set<string>,
) {
	const completions = output.api === "openai-completions";
	const key = (kind: string, id: string) => (completions && kind !== "tool" ? kind : `${kind}:${id}`);
	const blocks = new Map<string, { block: Block; index: number; json: string }>();
	const start = (id: string, block: Block, providerMetadata?: ProviderMetadata) => {
		const previous = blocks.get(id);
		if (previous && completions) return previous;
		if (previous) throw new Error(`Duplicate AI SDK content id: ${id}`);
		const entry = { block, index: output.content.length, json: "" };
		blocks.set(id, entry);
		metadata(block, providerMetadata);
		output.content.push(block);
		stream.push({
			type: block.type === "text" ? "text_start" : block.type === "thinking" ? "thinking_start" : "toolcall_start",
			contentIndex: entry.index,
			partial: output,
		});
		return entry;
	};
	const find = (id: string) => {
		const entry = blocks.get(id);
		if (!entry) throw new Error(`Unknown AI SDK content id: ${id}`);
		return entry;
	};
	return (part: TextStreamPart<ToolSet>): void => {
		switch (part.type) {
			case "text-start":
				start(key("text", part.id), { type: "text", text: "" }, part.providerMetadata);
				break;
			case "reasoning-start":
				start(key("reasoning", part.id), { type: "thinking", thinking: "" }, part.providerMetadata);
				break;
			case "text-delta":
			case "reasoning-delta": {
				const entry = find(key(part.type === "text-delta" ? "text" : "reasoning", part.id));
				metadata(entry.block, part.providerMetadata);
				if (entry.block.type === "text") {
					entry.block.text += part.text;
					stream.push({ type: "text_delta", contentIndex: entry.index, delta: part.text, partial: output });
				} else if (entry.block.type === "thinking") {
					entry.block.thinking += part.text;
					stream.push({ type: "thinking_delta", contentIndex: entry.index, delta: part.text, partial: output });
				}
				break;
			}
			case "text-end":
			case "reasoning-end": {
				if (completions) break;
				const entry = find(key(part.type === "text-end" ? "text" : "reasoning", part.id));
				metadata(entry.block, part.providerMetadata);
				if (entry.block.type === "text")
					stream.push({ type: "text_end", contentIndex: entry.index, content: entry.block.text, partial: output });
				else if (entry.block.type === "thinking")
					stream.push({
						type: "thinking_end",
						contentIndex: entry.index,
						content: entry.block.thinking,
						partial: output,
					});
				break;
			}
			case "tool-input-start":
				if (part.providerExecuted || part.inputEncoding === "text")
					throw new Error("AI SDK provider-executed and grammar tools require native conversion");
				start(
					`tool:${part.id}`,
					{ type: "toolCall", id: part.id, name: part.toolName, arguments: {} },
					part.providerMetadata,
				);
				if (emptyToolInputs?.has(part.id))
					stream.push({
						type: "toolcall_delta",
						contentIndex: find(`tool:${part.id}`).index,
						delta: "",
						partial: output,
					});
				break;
			case "tool-input-delta": {
				const entry = find(`tool:${part.id}`);
				entry.json += part.delta;
				if (entry.block.type !== "toolCall") throw new Error("Expected tool call");
				entry.block.arguments = parseStreamingJsonThrottled(entry.block.arguments, entry.json);
				metadata(entry.block, part.providerMetadata);
				stream.push({ type: "toolcall_delta", contentIndex: entry.index, delta: part.delta, partial: output });
				break;
			}
			case "tool-call": {
				const entry =
					blocks.get(`tool:${part.toolCallId}`) ??
					start(`tool:${part.toolCallId}`, {
						type: "toolCall",
						id: part.toolCallId,
						name: part.toolName,
						arguments: {},
					});
				if (entry.block.type !== "toolCall") throw new Error("Expected tool call");
				Object.assign(
					entry.block,
					parseToolCallArguments(
						entry.json || (typeof part.input === "string" ? part.input : JSON.stringify(part.input)),
					),
				);
				metadata(entry.block, part.providerMetadata);
				stream.push({ type: "toolcall_end", contentIndex: entry.index, toolCall: entry.block, partial: output });
				break;
			}
			case "finish":
			case "ping":
			case "raw":
			case "start":
			case "start-step":
			case "tool-input-end":
				break;
			case "steering-message":
			case "tool-approval-request":
			case "tool-approval-response":
			case "tool-output-denied":
				throw new Error(`Unexpected AI SDK control event: ${part.type}`);
			case "finish-step":
				if (completions)
					for (const { block, index } of blocks.values()) {
						if (block.type === "text")
							stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
						else if (block.type === "thinking")
							stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
					}
				break;
			case "error":
				throw part.error;
			case "abort":
				throw Object.assign(new Error(part.reason || "Request aborted"), { name: "AbortError" });
			case "custom":
				if (part.kind !== "anthropic.message_start")
					throw new Error(`AI SDK content requires native conversion: ${part.kind}`);
				if (typeof part.providerMetadata?.anthropic?.id === "string")
					output.responseId = part.providerMetadata.anthropic.id;
				break;
			case "file":
			case "reasoning-file":
			case "source":
			case "tool-result":
				throw new Error(`AI SDK content requires native conversion: ${part.type}`);
			case "tool-error":
				if (!part.providerExecuted) break;
				throw new Error(`AI SDK content requires native conversion: ${part.type}`);
		}
	};
}
