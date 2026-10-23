import { createPendingAssistantMessage } from "../utils/assistant-message.ts";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import type { AssistantMessage, Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import { resolveCacheRetention } from "../utils/cache-policy.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { failStreamTask } from "./lazy.ts";
import { getClientApiKey, headersToRecord } from "../utils/headers.ts";
import { requestJsonEventStream } from "../utils/json-event-stream.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { getDeclaredTools, resolveTranscript } from "../utils/transcript.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import {
	assertResponsesStreamCompleted,
	processResponsesStream,
	stripResponsesStreamScratch,
} from "./openai-responses-shared.ts";
import { getCompat, getConfigurationUpdateEffort } from "./openai-responses/compat.ts";
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
			...createPendingAssistantMessage(model),
			...(configurationUpdateEffort === undefined ? {} : { providerThinkingLevel: configurationUpdateEffort }),
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

			assertResponsesStreamCompleted(output, options?.signal, "OpenAI Responses");

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			stripResponsesStreamScratch(output);
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
