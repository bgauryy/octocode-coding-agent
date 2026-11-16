import type { AssistantMessage, Model } from "../../types.ts";
import { calculateCost } from "../../models/model-helpers.ts";
import { sumUsageTokens } from "../../utils/assistant-message.ts";
import { appendAssistantMessageDiagnostic } from "../../utils/diagnostics.ts";
import { parseStreamingJson } from "../../utils/json-parse.ts";
import { providerOutputText } from "../provider-output.ts";
import {
	anthropicAnnotation,
	anthropicNativeFields,
	anthropicNativeOutput,
} from "../anthropic-messages/rich-content.ts";
import { cacheMissDiagnostic } from "../anthropic-messages/cache-diagnostics.ts";
import type { AnthropicOptions } from "../anthropic-messages/types.ts";
import type { SdkMapping } from "./stream.ts";
import { applySdkUsage } from "./events.ts";

type RawBlock = Parameters<typeof anthropicNativeOutput>[0];
type Diagnostics = Parameters<typeof cacheMissDiagnostic>[0];
interface Usage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	output_tokens_details?: { thinking_tokens?: number };
	cache_creation_input_tokens?: number;
	cache_creation?: { ephemeral_1h_input_tokens?: number } | null;
}
interface Raw {
	type: string;
	index: number;
	content_block: RawBlock;
	message: {
		id: string;
		model?: string;
		usage: Usage;
		diagnostics?: Diagnostics;
		input_transformations?: { type?: string; path?: string; reason?: string }[];
	};
	delta: {
		type: string;
		partial_json?: string;
		content?: string;
		citation?: Parameters<typeof anthropicAnnotation>[0];
		stop_reason?: string;
		stop_details?: { type?: string; category?: string; explanation?: string; recommended_model?: string };
	};
	usage?: Usage;
	input_transformations?: Raw["message"]["input_transformations"];
}
export function anthropicSdkEvents(
	model: Model<"anthropic-messages">,
	options: AnthropicOptions,
	longCache: boolean,
): NonNullable<SdkMapping["onPart"]> {
	const artifacts = new Map<number, { index: number; type: string; fields?: Record<string, unknown>; json: string }>();
	const compactions = new Set<string>();
	const redacted = new Map<string, number>();
	let usage: Usage = {};
	let initialBlock: { type: string; text?: string; thinking?: string; signature?: string } | undefined;
	const seed = (output: AssistantMessage) => {
		const block = output.content.at(-1);
		if (block?.type === "text" && initialBlock?.type === "text") block.text = (initialBlock.text ?? "") + block.text;
		else if (block?.type === "thinking" && initialBlock?.type === "thinking") {
			block.thinking = (initialBlock.thinking ?? "") + block.thinking;
			block.thinkingSignature = (initialBlock.signature ?? "") + (block.thinkingSignature ?? "");
		} else return;
		initialBlock = undefined;
	};
	let responseModel: string | undefined;
	let transformations: Raw["message"]["input_transformations"];
	let stopDetails: Raw["delta"]["stop_details"];
	let rawStop: string | undefined;
	let sawDelta = false;
	let terminal = false;
	let mappedUnsupportedBlock = false;
	const apply = (output: AssistantMessage) => {
		output.usage.input = usage.input_tokens ?? 0;
		output.usage.output = usage.output_tokens ?? 0;
		output.usage.cacheRead = usage.cache_read_input_tokens ?? 0;
		output.usage.cacheWrite = usage.cache_creation_input_tokens ?? 0;
		output.usage.cacheWrite1h =
			usage.cache_creation?.ephemeral_1h_input_tokens ??
			(longCache && !usage.cache_creation ? output.usage.cacheWrite : 0);
		if (usage.output_tokens_details?.thinking_tokens != null)
			output.usage.reasoning = usage.output_tokens_details.thinking_tokens;
		output.usage.totalTokens = sumUsageTokens(output.usage);
		if (sawDelta) delete output.usage.lowerBound;
		else output.usage.lowerBound = true;
		const fallback = model.compat?.allowedFallbackModels?.find(
			(candidate) => candidate.provider === model.provider && candidate.model === responseModel,
		);
		calculateCost(fallback ? { ...model, cost: fallback.cost } : model, output.usage);
	};
	return (part, output, stream) => {
		if (part.type === "start") {
			if (options.thinkingBudgetReduction) output.thinkingBudget = options.thinkingBudgetReduction;
			if (
				model.compat?.supportsMidConvoEffort &&
				!(options.thinkingEnabled === false && model.thinkingLevelMap?.off !== null)
			)
				output.providerThinkingLevel = options.effort ?? "high";
		}
		if (part.type === "raw") {
			const raw = part.rawValue as Raw;
			mappedUnsupportedBlock = false;
			if (raw.type === "message_start") {
				output.responseId = raw.message.id;
				responseModel = raw.message.model;
				if (responseModel && responseModel !== model.id) output.responseModel = responseModel;
				usage = raw.message.usage;
				transformations = raw.message.input_transformations;
				const diagnostic = cacheMissDiagnostic(raw.message.diagnostics);
				if (diagnostic) appendAssistantMessageDiagnostic(output, diagnostic);
				apply(output);
			} else if (raw.type === "message_delta") {
				if (raw.input_transformations) transformations = raw.input_transformations;
				if (raw.usage) {
					const next = { ...raw.usage };
					for (const key of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const)
						if (next[key] === 0 && (usage[key] ?? 0) > 0) delete next[key];
					if (
						next.cache_creation_input_tokens != null &&
						next.cache_creation_input_tokens !== usage.cache_creation_input_tokens
					)
						delete usage.cache_creation;
					usage = { ...usage, ...next };
				}
				rawStop = raw.delta.stop_reason;
				stopDetails = raw.delta.stop_details;
				sawDelta = true;
				apply(output);
			} else if (raw.type === "message_stop") terminal = true;
			else if (raw.type === "content_block_start") {
				const block = raw.content_block;
				mappedUnsupportedBlock = block.type === "container_upload" || block.type === "mcp_tool_listing";
				if (block.type === "compaction") compactions.add(String(raw.index));
				if (block.type === "text" || block.type === "thinking")
					initialBlock = block as unknown as NonNullable<typeof initialBlock>;
				if (block.type === "fallback") {
					if (output.content.length) throw new Error("Anthropic performed an unsupported mid-output model fallback");
				} else if (!["text", "thinking", "tool_use", "redacted_thinking"].includes(block.type)) {
					const index = output.content.length;
					output.content.push(
						anthropicNativeOutput(block) ?? {
							type: "unsupported",
							providerType: block.type,
							text: `Provider output: ${block.type}`,
						},
					);
					artifacts.set(raw.index, { index, type: block.type, fields: anthropicNativeFields(block), json: "" });
					stream.push({ type: "content_update", contentIndex: index, partial: output });
				}
			} else if (raw.type === "content_block_delta") {
				seed(output);
				const artifact = artifacts.get(raw.index);
				if (artifact) {
					const block = output.content[artifact.index];
					if (raw.delta.type === "input_json_delta" && artifact.fields) {
						artifact.json += raw.delta.partial_json ?? "";
						artifact.fields.input = parseStreamingJson(artifact.json);
						output.content[artifact.index] = providerOutputText(artifact.type, artifact.fields);
					} else if (raw.delta.type === "compaction_delta" && raw.delta.content) {
						output.content[artifact.index] = {
							type: "text",
							text:
								block.type === "text" ? block.text + raw.delta.content : `Provider compaction:\n${raw.delta.content}`,
						};
					}
					stream.push({ type: "content_update", contentIndex: artifact.index, partial: output });
				} else if (raw.delta.type === "citations_delta" && raw.delta.citation) {
					const block = output.content.at(-1);
					if (block?.type === "text") {
						(block.annotations ??= []).push(anthropicAnnotation(raw.delta.citation));
						stream.push({ type: "content_update", contentIndex: output.content.length - 1, partial: output });
					}
				}
			} else if (raw.type === "content_block_stop") {
				seed(output);
				const artifact = artifacts.get(raw.index);
				if (artifact) {
					artifacts.delete(raw.index);
					const block = output.content[artifact.index];
					if (block.type === "text")
						stream.push({ type: "text_end", contentIndex: artifact.index, content: block.text, partial: output });
				}
			}
			return true;
		}
		if (
			part.type === "error" &&
			mappedUnsupportedBlock &&
			part.error instanceof Error &&
			part.error.name === "AI_TypeValidationError"
		) {
			mappedUnsupportedBlock = false;
			return true;
		}
		if (part.type === "reasoning-start" && typeof part.providerMetadata?.anthropic?.redactedData === "string") {
			const index = output.content.length;
			redacted.set(part.id, index);
			output.content.push({
				type: "thinking",
				thinking: "[Reasoning redacted]",
				redacted: true,
				thinkingSignature: part.providerMetadata.anthropic.redactedData,
			});
			stream.push({ type: "thinking_start", contentIndex: index, partial: output });
			return true;
		}
		if (part.type === "reasoning-end" && redacted.has(part.id)) {
			const index = redacted.get(part.id)!;
			redacted.delete(part.id);
			stream.push({ type: "thinking_end", contentIndex: index, content: "[Reasoning redacted]", partial: output });
			return true;
		}
		if (part.type === "finish") {
			applySdkUsage(output, part.totalUsage, model);
			apply(output);
			output.rawStopReason = rawStop ?? part.rawFinishReason;
			output.stopReason = ["end_turn", "stop_sequence", "pause_turn"].includes(output.rawStopReason ?? "")
				? "stop"
				: output.rawStopReason === "max_tokens"
					? "length"
					: output.rawStopReason === "tool_use"
						? "toolUse"
						: "error";
			if (!terminal) throw new Error("Anthropic stream ended before message_stop");
			if (output.stopReason === "error")
				output.errorMessage =
					output.rawStopReason === "refusal"
						? stopDetails?.explanation || "The model refused to complete the request"
						: output.rawStopReason === "model_context_window_exceeded"
							? "model_context_window_exceeded: the request reached the model's context window"
							: `Provider stopped with: ${output.rawStopReason}`;
			if (transformations?.length)
				appendAssistantMessageDiagnostic(output, {
					type: "anthropic_input_transformations",
					timestamp: Date.now(),
					details: { transformations },
				});
			return true;
		}
		if (
			(part.type === "text-start" || part.type === "text-delta" || part.type === "text-end") &&
			compactions.has(part.id)
		)
			return true;
		if (part.type === "source" || part.type === "file" || part.type === "reasoning-file") return true;
		if (
			(part.type === "tool-input-start" ||
				part.type === "tool-call" ||
				part.type === "tool-result" ||
				part.type === "tool-error") &&
			part.providerExecuted
		)
			return true;
		if (part.type === "tool-input-delta" || part.type === "tool-input-end") {
			if ([...artifacts.values()].some((artifact) => artifact.fields?.id === part.id)) return true;
		}
		if (part.type === "custom" && part.kind !== "anthropic.message_start") return true;
		return false;
	};
}
