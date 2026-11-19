import {
	experimental_streamTextLowMemory as streamText,
	type ModelMessage,
	type ToolSet,
	type ToolChoice,
	type TextStreamPart,
	type LanguageModelUsage,
	type LanguageModel,
} from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { Api, Model, StreamOptions, TranscriptContext, AssistantMessage, Usage } from "../../types.ts";
import { combineAbortSignals } from "../../utils/abort-signals.ts";
import { createPendingAssistantMessage } from "../../utils/assistant-message.ts";
import { formatProviderError, normalizeProviderError } from "../../utils/error-body.ts";
import { AssistantMessageEventStream } from "../../utils/event-stream.ts";
import { providerHeadersToRecord } from "../../utils/headers.ts";
import { retryAfterMsFromError } from "../../utils/provider-retry.ts";
import { getUserAgent } from "../../utils/user-agent.ts";
import { openAIEnvironmentHeaders } from "../openai-environment-headers.ts";
import { failStreamTask } from "../lazy.ts";
import { assertStreamCompleted } from "../stream-finalize.ts";
import { parseChunkUsage } from "../openai-completions/usage.ts";
import { normalizeCompletionsResponse, type CompletionsState } from "./completions.ts";
import { applySdkUsage, sdkEventProcessor } from "./events.ts";
import { sdkMessages, sdkTools } from "./messages.ts";
import { sdkModel } from "./provider.ts";
import { sdkProviderOptions } from "./options.ts";
import { observeSdkResponse, fetchSdkResponse } from "./transport.ts";

export interface SdkMapping {
	usage?: (usage: LanguageModelUsage) => Usage;
	messages?: ModelMessage[];
	tools?: ToolSet;
	providerOptions?: ProviderOptions;
	toolChoice?: ToolChoice<ToolSet>;
	includeRawChunks?: boolean;
	augmentRequest?: (body: Record<string, unknown>) => void;
	finalizeRequest?: (body: unknown) => void;
	completionsState?: CompletionsState;
	/** Wraps the network fetch of each attempt, after headers, augmentRequest and onPayload: request signing goes here. */
	networkFetch?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch;
	/** Builds the SDK model itself, for Node-only providers kept out of the shared (browser-visible) factory. */
	model?: (fetch: typeof globalThis.fetch) => LanguageModel;
	onPart?: (part: TextStreamPart<ToolSet>, output: AssistantMessage, stream: AssistantMessageEventStream) => boolean;
}

/**
 * The parts of the SDK's single-consumer stream. Leaving early only releases the reader: cancelling that stream sends an
 * `undefined` reason into SDK promises nobody awaits (unhandled rejections), and the abort in `streamSdk`'s `finally`
 * already ends the call.
 */
async function* partsOf<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

export function streamSdk(
	model: Model<Api>,
	context: TranscriptContext,
	options: StreamOptions = {},
	mapping?: SdkMapping,
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const output = createPendingAssistantMessage(model);
	const release = new AbortController();
	const completions: CompletionsState = mapping?.completionsState ?? { emptyToolInputs: new Set() };
	const signal = combineAbortSignals([options.signal, release.signal]);
	const run = async () => {
		try {
			options.signal?.throwIfAborted();
			const fetch: typeof globalThis.fetch = async (input, sdkInit) => {
				const init = sdkInit;
				const headers = new Headers(init?.headers);
				headers.set("user-agent", getUserAgent());
				for (const source of [model.headers, options.headers]) {
					for (const [name, value] of Object.entries(source ?? {})) {
						if (value === null) headers.delete(name);
						else headers.set(name, value);
					}
				}
				const network = mapping?.networkFetch?.(options.fetch ?? globalThis.fetch);
				const response = await fetchSdkResponse(
					model,
					network ? { ...options, fetch: network } : options,
					input,
					{ ...init, headers },
					mapping?.augmentRequest,
					mapping?.finalizeRequest,
				);
				// Bedrock streams binary AWS event-stream frames, not SSE; its mapping observes raw chunks.
				if (model.api === "bedrock-converse-stream") return response;
				return model.api === "openai-completions"
					? normalizeCompletionsResponse(
							response,
							completions,
							model as Model<"openai-completions">,
							options,
							signal.signal,
						)
					: observeSdkResponse(response, completions, model, options, signal.signal);
			};
			// One consumer reads `result.stream` once: the default result keeps a replay branch that buffers every part (raw
			// provider chunks included) until the reply ends, about 1 GB over a 300,000-delta reply.
			const result = streamText({
				// Errors arrive through the stream and leave as redacted error events; the SDK default would print raw APICallError (with secrets) to stderr.
				onError: () => {},
				model: mapping?.model ? mapping.model(fetch) : await sdkModel(model, options, fetch),
				messages: mapping?.messages ?? sdkMessages(model, context),
				allowSystemInMessages: true,
				tools: mapping?.tools ?? sdkTools(context),
				toolChoice: mapping?.toolChoice,
				include: { rawChunks: mapping?.includeRawChunks },
				maxOutputTokens:
					model.api === "anthropic-messages" || model.api === "bedrock-converse-stream"
						? (options.maxTokens ?? model.maxTokens)
						: model.api.endsWith("responses") && options.maxTokens
							? Math.max(16, options.maxTokens)
							: options.maxTokens,
				providerOptions: mapping?.providerOptions ?? (await sdkProviderOptions(model, options)),
				temperature:
					model.compat && "supportsTemperature" in model.compat && model.compat.supportsTemperature === false
						? undefined
						: options.temperature,
				maxRetries: 0,
				abortSignal: signal.signal,
				headers: providerHeadersToRecord(
					{
						"User-Agent": getUserAgent(),
						...(model.api === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}),
					},
					model.api.startsWith("openai-") ? openAIEnvironmentHeaders(options.env) : {},
					model.headers,
					options.headers,
				),
			});
			const process = sdkEventProcessor(output, stream, completions.emptyToolInputs);
			let started = false;
			let streamError: unknown;
			for await (const part of partsOf(result.stream)) {
				if (mapping?.onPart?.(part, output, stream)) continue;
				if (part.type === "error") {
					streamError ??= part.error;
					continue;
				}
				if (part.type === "start-step" && !started) {
					started = true;
					output.usage.lowerBound = true;
					stream.push({ type: "start", partial: output });
				}
				if (part.type === "raw") await options.onProviderStreamEvent?.(part.rawValue, model);
				if (part.type === "finish-step") {
					output.responseId = part.response.id;
					output.rawStopReason = part.rawFinishReason;
					if (part.response.modelId && part.response.modelId !== model.id) output.responseModel = part.response.modelId;
					if (model.api === "openai-completions") {
						for (const block of output.content)
							if (block.type === "thinking")
								block.thinkingSignature = completions.details
									? JSON.stringify(completions.details)
									: completions.reasoningField;
					}
				}
				if (part.type === "finish") {
					if (model.api === "openai-completions" && completions.usage)
						output.usage = parseChunkUsage(completions.usage, model as Model<"openai-completions">);
					else if (mapping?.usage) output.usage = mapping.usage(part.totalUsage);
					else applySdkUsage(output, part.totalUsage, model);
					output.stopReason =
						part.finishReason === "stop"
							? "stop"
							: part.finishReason === "length"
								? "length"
								: part.finishReason === "tool-calls"
									? "toolUse"
									: "error";
					if (output.stopReason === "error")
						output.errorMessage =
							model.api.startsWith("google-") || model.api === "bedrock-converse-stream"
								? completions.blockedPrompt
									? `The provider blocked the prompt: ${completions.blockedPrompt}`
									: `Provider stopped with: ${output.rawStopReason ?? part.finishReason}`
								: `Provider ${model.api === "openai-completions" ? "finish_reason" : "finish reason"}: ${part.rawFinishReason ?? part.finishReason}`;
				}
				process(part);
			}

			if (model.api.endsWith("responses") && completions.streamStarted && !completions.terminal)
				throw new Error("OpenAI Responses stream ended before a terminal response event");
			if (streamError)
				throw streamError instanceof Error ? streamError : new Error(normalizeProviderError(streamError).message);
			assertStreamCompleted(output, options.signal, "AI SDK");
			stream.push({ type: "done", reason: output.stopReason, message: output });
		} catch (caught) {
			const error = completions.error ?? caught;
			// Usage the endpoint already reported is billed even when the stream never reaches its finish chunk.
			if (model.api === "openai-completions" && completions.usage)
				output.usage = parseChunkUsage(completions.usage, model as Model<"openai-completions">);
			output.stopReason =
				options.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "aborted" : "error";
			output.errorMessage =
				model.api === "openai-completions" &&
				error instanceof Error &&
				error.message === "Response stream ended without a finish reason."
					? "Stream ended without finish_reason"
					: formatProviderError(
							model.api === "mistral-conversations"
								? { ...normalizeProviderError(error), messageCarriesBody: false }
								: normalizeProviderError(error),
							model.api === "openai-responses"
								? `${model.provider === "openai" ? "OpenAI" : model.provider} API error`
								: model.api === "mistral-conversations"
									? "Mistral API error"
									: undefined,
						);
			if (output.errorMessage?.includes("subscription_sharing_usage_limit_exceeded"))
				output.errorMessage += "\nCheck your ChatGPT usage: https://chatgpt.com/settings/usage";
			const retryAfterMs =
				retryAfterMsFromError(error) ?? retryAfterMsFromError(new Error(normalizeProviderError(error).body ?? ""));
			if (retryAfterMs !== undefined) output.retryAfterMs = retryAfterMs;
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			release.abort();
			signal.cleanup();
			stream.end();
		}
	};
	run().catch((error: unknown) => failStreamTask(stream, model, error, options.signal));
	return stream;
}
