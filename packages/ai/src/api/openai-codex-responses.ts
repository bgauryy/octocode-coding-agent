import { assertImageRequestPayload } from "../utils/image-input.ts";
import { createPendingAssistantMessage } from "../utils/assistant-message.ts";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type { AssistantMessage, Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import { combineAbortSignals } from "../utils/abort-signals.ts";
import { resolveCacheRetention } from "../utils/cache-policy.ts";
import { appendAssistantMessageDiagnostic, createAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { failStreamTask } from "./lazy.ts";
import { headersToRecord } from "../utils/headers.ts";
import { getDeclaredTools, resolveTranscript } from "../utils/transcript.ts";
import { uuidv7 } from "../utils/uuid.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import {
	isCodexNonTransportError,
	isPreviousResponseNotFoundError,
	isWebSocketConnectionLimitReachedError,
	ProviderStreamEventCallbackError,
} from "./openai-codex-responses/errors.ts";
import { processStream } from "./openai-codex-responses/events.ts";
import {
	buildRequestBody,
	buildSSEHeaders,
	buildWebSocketHeaders,
	extractAccountId,
	resolveCodexUrl,
	resolveCodexWebSocketUrl,
} from "./openai-codex-responses/request.ts";
import { CodexHttpError, isRetryableError, normalizeTimeoutMs } from "./openai-codex-responses/retry.ts";
import { compressRequestBodyZstd, parseErrorResponse } from "./openai-codex-responses/sse.ts";
import {
	BASE_DELAY_MS,
	DEFAULT_MAX_RETRIES,
	type OpenAICodexResponsesOptions,
	type RequestBody,
} from "./openai-codex-responses/types.ts";
import {
	closeOpenAICodexWebSocketSessions,
	isWebSocketSseFallbackActive,
	recordWebSocketFailure,
	recordWebSocketSseFallback,
} from "./openai-codex-responses/websocket-session.ts";
import { processWebSocketStream } from "./openai-codex-responses/websocket-stream.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { assertStreamCompleted, stripStreamScratch } from "./stream-finalize.ts";
import { buildBaseOptions, requestedReasoningEffort } from "./simple-options.ts";
import { createAbortError, sleepUnlessAborted } from "../utils/abort.ts";
import { retryAfterMsFromError } from "../utils/provider-retry.ts";
import { parseRetryAfterMs, RetryDelayExceededError, validateRetryDelayMs } from "../utils/retry.ts";

export type { OpenAICodexResponsesOptions } from "./openai-codex-responses/types.ts";
export {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	type OpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
} from "./openai-codex-responses/websocket-session.ts";

registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

export const stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
	model: Model<"openai-codex-responses">,
	context: TranscriptContext,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages);

	(async () => {
		const output: AssistantMessage = createPendingAssistantMessage(model, "openai-codex-responses");

		try {
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const accountId = extractAccountId(apiKey);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			const cacheSessionId =
				resolveCacheRetention(options?.cacheRetention, options?.env) === "none" ? undefined : options?.sessionId;
			const codexSessionId = clampOpenAIPromptCacheKey(cacheSessionId);
			let body = buildRequestBody(model, normalizedContext, options, codexSessionId, grammarToolInputProperties);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as RequestBody;
			}
			assertImageRequestPayload(model, body);
			const websocketRequestId = codexSessionId || uuidv7();
			const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, codexSessionId);
			const websocketHeaders = buildWebSocketHeaders(
				model.headers,
				options?.headers,
				accountId,
				apiKey,
				websocketRequestId,
			);
			const bodyJson = JSON.stringify(body);
			const httpTimeoutMs = normalizeTimeoutMs(options?.timeoutMs);
			const websocketConnectTimeoutMs = normalizeTimeoutMs(options?.websocketConnectTimeoutMs);
			const transport = options?.transport || "auto";
			let startEmitted = false;
			const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(cacheSessionId);
			if (websocketDisabledForSession) {
				recordWebSocketSseFallback(cacheSessionId);
			}

			if (transport !== "sse" && !websocketDisabledForSession) {
				let websocketStarted = false;
				let retriedWebSocketConnectionLimit = false;
				let retriedMissingWebSocketContinuation = false;
				while (true) {
					websocketStarted = false;
					try {
						await processWebSocketStream(
							resolveCodexWebSocketUrl(model.baseUrl),
							body,
							websocketHeaders,
							output,
							stream,
							model,
							() => {
								websocketStarted = true;
								if (!startEmitted) {
									startEmitted = true;
									stream.push({ type: "start", partial: output });
								}
							},
							httpTimeoutMs,
							websocketConnectTimeoutMs,
							cacheSessionId,
							accountId,
							grammarToolInputProperties,
							{ ...options, transport },
						);

						assertStreamCompleted(output, options?.signal, "Codex");
						stream.push({
							type: "done",
							reason: output.stopReason,
							message: output,
						});
						stream.end();
						return;
					} catch (error) {
						const aborted = options?.signal?.aborted;
						const connectionLimitBeforeStart = !websocketStarted && isWebSocketConnectionLimitReachedError(error);
						const previousResponseNotFound = isPreviousResponseNotFoundError(error);
						if (!aborted && previousResponseNotFound && !retriedMissingWebSocketContinuation) {
							retriedMissingWebSocketContinuation = true;
							continue;
						}
						if (!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit) {
							retriedWebSocketConnectionLimit = true;
							continue;
						}
						if (aborted || (isCodexNonTransportError(error) && !connectionLimitBeforeStart)) {
							throw error;
						}
						appendAssistantMessageDiagnostic(
							output,
							createAssistantMessageDiagnostic("provider_transport_failure", error, {
								configuredTransport: transport,
								...(websocketStarted ? {} : { fallbackTransport: "sse" }),
								eventsEmitted: websocketStarted,
								phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
								requestBytes: new TextEncoder().encode(bodyJson).byteLength,
							}),
						);
						recordWebSocketFailure(cacheSessionId, error);
						if (websocketStarted) {
							throw error;
						}
						recordWebSocketSseFallback(cacheSessionId);
						break;
					}
				}
			}

			// Compress the request body once for the SSE path. The Codex backend
			// decodes Content-Encoding: zstd; the WebSocket transport above sends the
			// uncompressed JSON frame, matching the official Codex client.
			const compressedBody = compressRequestBodyZstd(bodyJson);
			if (compressedBody) {
				sseHeaders.set("content-encoding", "zstd");
			}
			const sseBody: Uint8Array<ArrayBuffer> | string = compressedBody ?? bodyJson;

			// Fetch with retry logic for rate limits and transient errors
			let response: Response | undefined;
			let lastError: Error | undefined;
			const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;

			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				if (options?.signal?.aborted) {
					throw createAbortError();
				}

				try {
					const headerTimeoutSignal =
						httpTimeoutMs !== undefined && httpTimeoutMs > 0 ? AbortSignal.timeout(httpTimeoutMs) : undefined;
					const combinedSignal = combineAbortSignals([options?.signal, headerTimeoutSignal]);
					try {
						response = await (options?.fetch ?? globalThis.fetch)(resolveCodexUrl(model.baseUrl), {
							method: "POST",
							headers: sseHeaders,
							body: sseBody,
							signal: combinedSignal.signal,
						});
					} catch (error) {
						if (headerTimeoutSignal?.aborted && !options?.signal?.aborted) {
							throw new Error(`Codex SSE response headers timed out after ${httpTimeoutMs}ms`, { cause: error });
						}
						throw error;
					} finally {
						combinedSignal.cleanup();
					}
					try {
						await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
					} catch (error) {
						await response.body?.cancel().catch(() => {});
						throw new ProviderStreamEventCallbackError(error);
					}

					if (response.ok) {
						break;
					}

					const errorText = await response.text();
					if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
						const retryAfterDelayMs = parseRetryAfterMs(response.headers);
						const delayMs =
							retryAfterDelayMs === undefined
								? BASE_DELAY_MS * 2 ** attempt
								: validateRetryDelayMs(retryAfterDelayMs, options?.maxRetryDelayMs, undefined, response);

						await sleepUnlessAborted(delayMs, options?.signal, createAbortError);
						continue;
					}

					// Parse error for friendly message on final attempt or non-retryable error
					const fakeResponse = new Response(errorText, {
						status: response.status,
						statusText: response.statusText,
					});
					const info = await parseErrorResponse(fakeResponse);
					throw new CodexHttpError(info.friendlyMessage || info.message, response.status, response.headers);
				} catch (error) {
					// Final HTTP errors and caller hook failures must not resubmit the request.
					if (error instanceof CodexHttpError || error instanceof ProviderStreamEventCallbackError) throw error;
					if (error instanceof Error) {
						if (error.name === "AbortError") {
							throw createAbortError();
						}
					}
					lastError = error instanceof Error ? error : new Error(String(error));
					// Network errors are retryable
					if (
						attempt < maxRetries &&
						!(lastError instanceof RetryDelayExceededError) &&
						!lastError.message.includes("usage limit")
					) {
						const delayMs = BASE_DELAY_MS * 2 ** attempt;
						await sleepUnlessAborted(delayMs, options?.signal, createAbortError);
						continue;
					}
					throw lastError;
				}
			}

			if (!response?.ok) {
				throw lastError ?? new Error("Failed after retries");
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			if (!startEmitted) {
				startEmitted = true;
				stream.push({ type: "start", partial: output });
			}
			await processStream(response, output, stream, model, grammarToolInputProperties, options);

			assertStreamCompleted(output, options?.signal, "Codex");
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			stripStreamScratch(output);
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			const retryAfterMs = retryAfterMsFromError(error);
			if (retryAfterMs !== undefined) output.retryAfterMs = retryAfterMs;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})().catch((error: unknown) => failStreamTask(stream, model, error, options?.signal));

	return stream;
};

export const streamSimple: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (
	model: Model<"openai-codex-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies OpenAICodexResponsesOptions;
	const reasoningEffort = requestedReasoningEffort(model, options);

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAICodexResponsesOptions);
};
