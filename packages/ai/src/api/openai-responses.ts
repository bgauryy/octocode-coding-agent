import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type { AssistantMessage, Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import { resolveCacheRetention } from "../utils/cache-policy.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { failStreamTask } from "./lazy.ts";
import { headersToRecord } from "../utils/headers.ts";
import { requestJsonEventStream } from "../utils/json-event-stream.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { getDeclaredTools, resolveTranscript } from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { processResponsesStream } from "./openai-responses-shared.ts";
import { getClientApiKey, getCompat, getConfigurationUpdateEffort } from "./openai-responses/compat.ts";
import { applyServiceTierPricing, buildParams, createRequestHeaders } from "./openai-responses/request.ts";
import type { OpenAIResponsesOptions, ResponsesRequest } from "./openai-responses/types.ts";
import { buildBaseOptions } from "./simple-options.ts";

export type { OpenAIResponsesOptions } from "./openai-responses/types.ts";

const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

/**
 * Generate function for OpenAI Responses API
 */
export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);

	// Start async processing
	(async () => {
		const compat = getCompat(model);
		const configurationUpdateEffort = getConfigurationUpdateEffort(model, options, compat);
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			...(configurationUpdateEffort === undefined ? {} : { providerThinkingLevel: configurationUpdateEffort }),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				compat.supportsOpenAIGrammarTools,
			);
			const headers = createRequestHeaders(
				model,
				normalizedContext,
				apiKey,
				options?.headers,
				cacheSessionId,
				options?.env,
			);
			let params = buildParams(
				model,
				normalizedContext,
				options,
				compat,
				grammarToolInputProperties,
				configurationUpdateEffort,
			);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponsesRequest;
			}
			const url = new URL(model.baseUrl);
			url.pathname = `${url.pathname.replace(/\/$/, "")}/responses`;
			const request = await retryProviderRequest(() => requestJsonEventStream(url, params, headers, options), {
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal,
			});
			try {
				await options?.onResponse?.(
					{ status: request.response.status, headers: headersToRecord(request.response.headers) },
					model,
				);
				stream.push({ type: "start", partial: output });

				await processResponsesStream(request.events as AsyncIterable<ResponseStreamEvent>, output, stream, model, {
					onProviderStreamEvent: options?.onProviderStreamEvent,
					serviceTier: options?.serviceTier,
					grammarToolInputProperties,
					applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
				});
			} finally {
				request.dispose();
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("OpenAI Responses stream ended without a stop reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// Streaming scratch buffers are only used during parsing; never persist them.
				delete (block as { partialJson?: string }).partialJson;
				delete (block as { customInput?: unknown }).customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			const errorMessage = formatProviderError(
				normalizeProviderError(error),
				`${model.provider === "openai" ? "OpenAI" : model.provider} API error`,
			);
			// Sign in with ChatGPT shares the subscription's usage limit with other apps.
			output.errorMessage = errorMessage.includes("subscription_sharing_usage_limit_exceeded")
				? `${errorMessage}\nCheck your ChatGPT usage: ${CHATGPT_USAGE_URL}`
				: errorMessage;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})().catch((error: unknown) => failStreamTask(stream, model, error, options?.signal));

	return stream;
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};
