import { assertImageRequestPayload } from "../utils/image-input.ts";
import { retryAfterMsFromError } from "../utils/provider-retry.ts";
import { createPendingAssistantMessage } from "../utils/assistant-message.ts";
import type OpenAI from "openai";
import { clampThinkingLevel } from "../models/model-helpers.ts";
import type { AssistantMessage, Model, SimpleStreamOptions, StreamFunction, ThinkingContent } from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { failStreamTask } from "./lazy.ts";
import { getClientApiKey } from "../utils/headers.ts";
import { resolveCacheRetention } from "../utils/cache-policy.ts";
import { getDeclaredTools, resolveTranscript, type TranscriptContext } from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { createClient } from "./openai-completions/client.ts";
import { requestOpenAISdkStream } from "./openai-sdk-request.ts";
import { getCompat } from "./openai-completions/compat.ts";
import { buildParams } from "./openai-completions/params.ts";
import {
	applyStreamedReasoningDetails as applyReasoningDetails,
	type StreamedReasoningDetails,
} from "./openai-completions/reasoning-details.ts";
import { createCompletionsChunkProcessor } from "./openai-completions/stream-events.ts";
import type { OpenAICompletionsOptions } from "./openai-completions/types.ts";
import { buildBaseOptions } from "./simple-options.ts";

export { convertMessages } from "./openai-completions/messages.ts";
export type { OpenAICompletionsOptions } from "./openai-completions/types.ts";

export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);

	(async () => {
		const output: AssistantMessage = createPendingAssistantMessage(model);

		// `reasoning_details` are replay metadata, not user-visible stream deltas.
		// Keep them in memory during streaming and serialize once when the block is finalized.
		const streamedReasoningDetails: StreamedReasoningDetails = {};
		const applyStreamedReasoningDetails = (block: ThinkingContent): void => {
			applyReasoningDetails(block, streamedReasoningDetails);
		};

		try {
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const client = createClient(
				model,
				normalizedContext,
				apiKey,
				options?.headers,
				options?.fetch,
				cacheSessionId,
				compat,
			);
			let params = buildParams(
				model,
				normalizedContext,
				options,
				compat,
				cacheRetention,
				grammarToolInputProperties,
				(reduction) => {
					output.thinkingBudget = reduction;
				},
			);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
			}
			assertImageRequestPayload(model, params);
			const openaiStream = await requestOpenAISdkStream(model, options, (requestOptions) =>
				client.chat.completions.create(params, requestOptions),
			);
			stream.push({ type: "start", partial: output });

			const processor = createCompletionsChunkProcessor(
				model,
				output,
				stream,
				grammarToolInputProperties,
				streamedReasoningDetails,
			);
			for await (const chunk of openaiStream) {
				await options?.onProviderStreamEvent?.(chunk, model);
				if (!chunk || typeof chunk !== "object") continue;
				processor.processChunk(chunk);
			}

			processor.finishBlocks();
			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted") {
				throw new Error("Request was aborted");
			}
			if (!processor.hasFinishReason() && !compat.supportsFinishReason) {
				output.stopReason = output.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
			}
			if (output.stopReason === "error") {
				throw new Error(output.errorMessage || "Provider returned an error stop reason");
			}
			if ((compat.supportsFinishReason && !processor.hasFinishReason()) || output.stopReason === "pending") {
				throw new Error("Stream ended without finish_reason");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "thinking") {
					applyStreamedReasoningDetails(block);
				}
				delete (block as { index?: number }).index;
				// Streaming scratch buffers are only used during parsing; never persist them.
				delete (block as { partialArgs?: string }).partialArgs;
				delete (block as { customInput?: unknown }).customInput;
				delete (block as { streamIndex?: number }).streamIndex;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			const retryAfterMs = retryAfterMsFromError(error);
			if (retryAfterMs !== undefined) output.retryAfterMs = retryAfterMs;
			// Some providers via OpenRouter give additional information in this field.
			// normalizeProviderError already stringifies the parsed body (error.error)
			// into errorMessage, so only append the raw metadata when it is not already
			// present to avoid double-printing it.
			const rawMetadata = (error as any)?.error?.metadata?.raw;
			if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) {
				output.errorMessage += `\n${rawMetadata}`;
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})().catch((error: unknown) => failStreamTask(stream, model, error, options?.signal));

	return stream;
};

export const streamSimple: StreamFunction<"openai-completions", SimpleStreamOptions> = (
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAICompletionsOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
		thinkingBudgets: options?.thinkingBudgets,
	} satisfies OpenAICompletionsOptions);
};
