import { assertStreamCompleted, stripStreamScratch } from "./stream-finalize.ts";
import { assertImageRequestPayload } from "../utils/image-input.ts";
import { createPendingAssistantMessage } from "../utils/assistant-message.ts";
import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import type { AssistantMessage, Model, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { resolveCacheAffinityId } from "../utils/cache-policy.ts";
import { appendAssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { redactProviderText, withNetworkCauseCode } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { failStreamTask } from "./lazy.ts";
import { headersToRecord } from "../utils/headers.ts";
import { clampThinkingLevel } from "../models/model-helpers.ts";
import { retryAfterMsFromError, retryProviderRequest } from "../utils/provider-retry.ts";
import { getCurrentTools, resolveTranscript, type TranscriptContext } from "../utils/transcript.ts";

import { copilotDynamicHeadersFor } from "./github-copilot-headers.ts";
import {
	adjustMaxTokensForThinking,
	buildBaseOptions,
	clampMaxTokensToContext,
	thinkingBudgetForLevel,
	thinkingBudgetReduction,
} from "./simple-options.ts";
import { assertRequestAuth, createClient, getAnthropicFederation } from "./anthropic-messages/client.ts";
import { getAnthropicCompat } from "./anthropic-messages/compat.ts";
import { buildParams } from "./anthropic-messages/params.ts";
import { refuseClaudeSubscriptionToken } from "./anthropic-messages/token.ts";
import { hasStrictToolDowngrade, rememberStrictToolDowngrade } from "./anthropic-messages/strict-tool-downgrades.ts";
import { iterateAnthropicEvents } from "./anthropic-messages/sse.ts";
import { fitClaudeThinkingBudget } from "./anthropic-messages/thinking-budget.ts";
import {
	type AnthropicStreamState,
	handleAnthropicStreamEvent,
	requestsLongCache,
} from "./anthropic-messages/stream-events.ts";
import type { AnthropicEffort, AnthropicOptions } from "./anthropic-messages/types.ts";

export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./anthropic-messages/types.ts";

export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, getAnthropicCompat(model).supportsMidConvoSystemMessages);
	const currentTools = getCurrentTools(normalizedContext.messages);

	(async () => {
		const output: AssistantMessage = createPendingAssistantMessage(model);
		if (options?.thinkingBudgetReduction) output.thinkingBudget = options.thinkingBudgetReduction;

		try {
			// A subscription token is refused before any request is built, whichever client sends it.
			refuseClaudeSubscriptionToken(options?.apiKey, { ...model.headers, ...options?.headers });
			let client: Anthropic;

			if (options?.client) {
				client = options.client;
			} else {
				const apiKey = options?.apiKey;
				const federation = getAnthropicFederation(model, apiKey, options?.headers, options?.env);
				if (!federation) assertRequestAuth(model.provider, apiKey, options?.headers);

				const copilotDynamicHeaders = copilotDynamicHeadersFor(model.provider, normalizedContext.messages);

				const cacheSessionId = resolveCacheAffinityId(options);

				client = createClient(
					model,
					apiKey,
					options?.headers,
					options?.fetch,
					copilotDynamicHeaders,
					cacheSessionId,
					federation,
				);
			}
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: 0,
			};
			let disablePreferredStrictTools = hasStrictToolDowngrade(model, currentTools);
			let response: Response;
			let sentParams: MessageCreateParamsStreaming;
			for (;;) {
				options?.signal?.throwIfAborted();
				const built = buildParams(model, normalizedContext, options, disablePreferredStrictTools);
				if (built.providerThinkingLevel) output.providerThinkingLevel = built.providerThinkingLevel;
				let params = built.params;
				const nextParams = await options?.onPayload?.(params, model);
				if (nextParams !== undefined) {
					params = { ...(nextParams as MessageCreateParamsStreaming), stream: true };
				}
				assertImageRequestPayload(model, params);
				sentParams = params;
				try {
					response = await retryProviderRequest(
						() => client.beta.messages.create(params, requestOptions).asResponse(),
						{
							maxRetries: options?.maxRetries,
							maxRetryDelayMs: options?.maxRetryDelayMs,
							signal: options?.signal,
						},
					);
					break;
				} catch (error) {
					// Only downgrade a rejected request, never an already-started stream.
					if (
						options?.signal?.aborted ||
						disablePreferredStrictTools ||
						!built.hasPreferredStrictTools ||
						!(error instanceof Anthropic.APIError) ||
						error.status !== 400 ||
						error.type !== "invalid_request_error" ||
						![
							"The compiled grammar is too large",
							"Too many strict tools (",
							"Schemas contains too many parameters with union types (",
						].some((message) => error.message.includes(message))
					) {
						throw error;
					}
					disablePreferredStrictTools = true;
					rememberStrictToolDowngrade(model, currentTools);
					appendAssistantMessageDiagnostic(output, {
						type: "anthropic_strict_tools_fallback",
						timestamp: Date.now(),
						error: { message: error.message },
						details: { reason: "strict_tool_limits_exceeded" },
					});
				}
			}
			try {
				await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			} catch (error) {
				// Release the streaming body so the connection closes and the server stops generating.
				await response.body?.cancel().catch(() => {});
				throw error;
			}
			stream.push({ type: "start", partial: output });

			const state: AnthropicStreamState = {
				model,
				output,
				stream,
				usageModel: model,
				longCacheRequested: requestsLongCache(sentParams),
				inputTransformations: undefined,
			};
			for await (const event of iterateAnthropicEvents(response, options?.signal)) {
				await options?.onProviderStreamEvent?.(event, model);
				handleAnthropicStreamEvent(event, state);
			}
			const { inputTransformations } = state;

			assertStreamCompleted(output, options?.signal, "Anthropic");
			if (inputTransformations && inputTransformations.length > 0) {
				appendAssistantMessageDiagnostic(output, {
					type: "anthropic_input_transformations",
					timestamp: Date.now(),
					details: {
						transformations: inputTransformations.map((transformation) => ({
							type: transformation.type ?? undefined,
							path: transformation.path ?? undefined,
							reason: transformation.reason ?? undefined,
						})),
					},
				});
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			stripStreamScratch(output);
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = redactProviderText(
				error instanceof Error ? withNetworkCauseCode(error) : JSON.stringify(error),
			);
			const retryAfterMs = retryAfterMsFromError(error);
			if (retryAfterMs !== undefined) output.retryAfterMs = retryAfterMs;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})().catch((error: unknown) => failStreamTask(stream, model, error, options?.signal));

	return stream;
};

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is available on all adaptive-thinking Claude models, while native
 * "xhigh" is only available on Opus 4.7/4.8, Sonnet 5, and Fable 5.
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	if (!getAnthropicFederation(model, options?.apiKey, options?.headers, options?.env)) {
		assertRequestAuth(model.provider, options?.apiKey, options?.headers);
	}

	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies AnthropicOptions;
	if (!options?.reasoning) {
		// A model that cannot turn thinking off (`off: null`) thinks anyway; without an effort it would think at the
		// default `high` and can spend a small `maxTokens` before writing any text. Ask for its least effort instead.
		const lowest =
			model.reasoning && model.thinkingLevelMap?.off === null ? clampThinkingLevel(model, "minimal") : "off";
		const least = lowest === "off" ? undefined : mapThinkingLevelToEffort(model, lowest);
		return stream(model, context, {
			...base,
			thinkingEnabled: false,
			...(least ? { effort: least } : {}),
		} satisfies AnthropicOptions);
	}

	// For models with adaptive thinking: use an effort level.
	// For older models: use budget-based thinking.
	if (model.compat?.forceAdaptiveThinking === true) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return stream(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
		} satisfies AnthropicOptions);
	}

	// Undefined means the caller did not request an output cap; let the helper use the model cap.
	// Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
	const thinkingBudgetTokens = fitClaudeThinkingBudget(adjusted.thinkingBudget, maxTokens);
	// Requested: the budget that fits the model's own output cap; a further cut came from the context clamp.
	const reduction = thinkingBudgetReduction(
		fitClaudeThinkingBudget(thinkingBudgetForLevel(options.reasoning, options.thinkingBudgets), model.maxTokens),
		thinkingBudgetTokens,
	);
	// The API rejects a budget under its 1024-token minimum, and a turn this close to the context limit cannot hold one:
	// answer without thinking rather than send a request that fails.
	if (thinkingBudgetTokens === 0) {
		return stream(model, context, {
			...base,
			maxTokens,
			thinkingEnabled: false,
			thinkingBudgetReduction: reduction,
		} satisfies AnthropicOptions);
	}

	return stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens,
		thinkingBudgetReduction: reduction,
	} satisfies AnthropicOptions);
};
