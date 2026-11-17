import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ToolChoice, ToolSet } from "ai";
import type { TranscriptContext } from "../../types.ts";
import type { ResponsesModel } from "./responses-model.ts";
import { responsesMessages } from "./responses-messages.ts";
import { responsesRich } from "./responses-rich.ts";
import { responsesPayload } from "./responses-payload.ts";
import { getProviderCapabilities } from "../../utils/provider-capabilities.ts";
import { resolveOpenAIResponsesCacheFields } from "../openai-prompt-cache.ts";
import { getCompat, getConfigurationUpdateEffort, isChatGPTSignIn } from "../openai-responses/compat.ts";
import type { OpenAIResponsesOptions } from "../openai-responses/types.ts";
import type { SdkMapping } from "./stream.ts";
import { applySdkUsage } from "./events.ts";
import { calculateCost } from "../../models/model-helpers.ts";
import { parseTextSignature } from "../openai-responses-shared/text-signature.ts";
import { applyServiceTierPricing } from "../openai-responses-shared/service-tier.ts";

export function responsesMapping(
	model: ResponsesModel,
	options: OpenAIResponsesOptions = {},
	context?: TranscriptContext,
) {
	const compat = getCompat(model);
	const signIn = isChatGPTSignIn(model, options.apiKey);
	const cache = resolveOpenAIResponsesCacheFields(compat, options, signIn);
	const requested = options.reasoningEffort ?? (options.reasoningSummary ? "medium" : undefined);
	const update = getConfigurationUpdateEffort(model, options, compat);
	const mapped = requested ? (model.thinkingLevelMap?.[requested] ?? requested) : undefined;
	const reasoning = model.reasoning
		? mapped
			? {
					reasoningEffort: update === undefined ? mapped : "medium",
					reasoningSummary: options.reasoningSummary || "auto",
				}
			: getProviderCapabilities(model.provider).acceptsReasoningOff && model.thinkingLevelMap?.off !== null
				? { reasoningEffort: model.thinkingLevelMap?.off ?? "none" }
				: {}
		: {};
	const openai = {
		store: false,
		forceReasoning: model.reasoning,
		systemMessageMode: model.reasoning && compat.supportsDeveloperRole ? "developer" : "system",
		strictJsonSchema: compat.supportsStrictMode,
		...reasoning,

		...(cache.prompt_cache_key === undefined ? {} : { promptCacheKey: cache.prompt_cache_key }),
		...(cache.prompt_cache_retention === undefined ? {} : { promptCacheRetention: cache.prompt_cache_retention }),
		...(cache.prompt_cache_options === undefined ? {} : { promptCacheOptions: cache.prompt_cache_options }),
		...(options.serviceTier === undefined ? {} : { serviceTier: options.serviceTier }),
		...(model.reasoning && (requested || getProviderCapabilities(model.provider).alwaysIncludeEncryptedReasoning)
			? { include: ["reasoning.encrypted_content"] }
			: {}),
	};
	let toolChoice: ToolChoice<ToolSet> | undefined;
	if (typeof options.toolChoice === "string") toolChoice = options.toolChoice;
	else if (options.toolChoice?.type === "function") toolChoice = { type: "tool", toolName: options.toolChoice.name };
	let serviceTier = options.serviceTier;
	const reasoningSignatures = new Map<string, string>();
	const rich = responsesRich(context);
	const onPart: NonNullable<SdkMapping["onPart"]> = (part, output, stream) => {
		if (rich(part, output, stream)) return true;
		if (part.type === "raw") {
			const event = part.rawValue as {
				type?: string;
				response?: { id?: string };
				item?: {
					type?: string;
					id?: string;
					content?: { type?: string; text?: string }[];
					summary?: { type?: string; text?: string }[];
				};
			};
			if (event.response?.id) output.responseId = event.response.id;
			if (event.type === "response.output_item.done" && event.item?.type === "reasoning" && event.item.id) {
				const item = event.item;
				reasoningSignatures.set(event.item.id, JSON.stringify(item));
				const block = output.content.find(
					(block) =>
						block.type === "thinking" &&
						block.thinkingSignature &&
						(JSON.parse(block.thinkingSignature) as { id?: string }).id === item.id,
				);
				if (block?.type === "thinking" && item.summary) {
					const text = item.summary.map((part) => part.text ?? "").join("\n");
					if (text.startsWith(block.thinking) && text !== block.thinking) {
						const delta = text.slice(block.thinking.length);
						block.thinking = text;
						stream.push({
							type: "thinking_delta",
							contentIndex: output.content.indexOf(block),
							delta,
							partial: output,
						});
					}
				}
			}
			if (event.type === "response.output_item.done" && event.item?.type === "message") {
				const item = event.item;
				const text = item.content
					?.filter((block) => block.type === "output_text")
					.map((block) => block.text ?? "")
					.join("");
				const index = output.content.findIndex(
					(block) => block.type === "text" && parseTextSignature(block.textSignature)?.id === item.id,
				);
				const block = output.content[index];
				if (text !== undefined && block?.type === "text" && text.startsWith(block.text) && text !== block.text) {
					const delta = text.slice(block.text.length);
					block.text = text;
					stream.push({ type: "text_delta", contentIndex: index, delta, partial: output });
				}
			}
			return true;
		}
		if (part.type === "start" && update !== undefined) output.providerThinkingLevel = update;
		if (part.type === "finish-step") {
			if (typeof part.providerMetadata?.openai?.serviceTier === "string")
				serviceTier = part.providerMetadata.openai.serviceTier as OpenAIResponsesOptions["serviceTier"];
			if (!output.responseId) output.responseId = part.response.id;
			output.rawStopReason = part.rawFinishReason;
			if (part.response.modelId && part.response.modelId !== model.id) output.responseModel = part.response.modelId;
			return true;
		}
		if (part.type !== "finish") return false;
		for (const block of output.content) {
			if (block.type !== "thinking" || !block.thinkingSignature) continue;
			const id = (JSON.parse(block.thinkingSignature) as { id?: string }).id;
			const signature = id ? reasoningSignatures.get(id) : undefined;
			if (signature) block.thinkingSignature = signature;
		}
		applySdkUsage(output, part.totalUsage, model);
		const raw = part.totalUsage.raw as
			| {
					input_tokens_details?: {
						cache_write_tokens_details?: { ttl_30m_tokens?: number; ttl_12h_tokens?: number };
					};
			  }
			| undefined;
		const writes = raw?.input_tokens_details?.cache_write_tokens_details;
		if (writes !== undefined) {
			output.usage.cacheWrite12h = writes.ttl_12h_tokens ?? 0;
			output.usage.cacheWrite30m = writes.ttl_30m_tokens ?? 0;
			calculateCost(model, output.usage);
		}
		applyServiceTierPricing(output.usage, serviceTier, model);
		output.stopReason =
			part.finishReason === "stop"
				? "stop"
				: part.finishReason === "length"
					? "length"
					: part.finishReason === "tool-calls"
						? "toolUse"
						: "error";
		if (output.stopReason === "error")
			output.errorMessage = `Provider finish reason: ${part.rawFinishReason ?? part.finishReason}`;
		return true;
	};
	return {
		includeRawChunks: true,
		onPart,
		augmentRequest: context ? responsesPayload(model, context, options) : undefined,
		...(context ? responsesMessages(model, context, options) : {}),
		providerOptions: { openai } as ProviderOptions,
		toolChoice,
	};
}
