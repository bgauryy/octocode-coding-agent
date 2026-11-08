import { createAbortError } from "../utils/abort.ts";
import { assertImageRequestPayload } from "../utils/image-input.ts";
import { retryAfterMsFromError } from "../utils/provider-retry.ts";
import { createPendingAssistantMessage } from "../utils/assistant-message.ts";
import { BedrockRuntimeClient, ConversationRole, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import type { AssistantMessage, Model, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { failStreamTask } from "./lazy.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { splitSystemMessageAtBoundary } from "../utils/instruction-split.ts";
import { getSystemMessageText } from "../utils/text.ts";
import {
	collapseSystemMessages,
	getCurrentTools,
	getInitialSystemMessage,
	type TranscriptContext,
} from "../utils/transcript.ts";
import {
	adjustMaxTokensForThinking,
	buildBaseOptions,
	clampMaxTokensToContext,
	clampReasoning,
	thinkingBudgetForLevel,
	thinkingBudgetReduction,
} from "./simple-options.ts";
import { resolveLayeredCacheRetention } from "../utils/cache-policy.ts";
import { fitClaudeThinkingBudget } from "./anthropic-messages/thinking-budget.ts";
import { buildBedrockClientConfig } from "./bedrock-converse-stream/client-config.ts";
import {
	addHistoryLookbackCachePoint,
	capLayeredCacheRetention,
	capNovaCachePoints,
	countCachePoints,
	getCachePoint,
} from "./bedrock-converse-stream/cache-points.ts";
import { buildSystemPrompt, convertMessages, convertToolConfig } from "./bedrock-converse-stream/convert.ts";
import {
	appendBedrockFailureDiagnostic,
	formatBedrockError,
	normalizeDiagnosticValue,
} from "./bedrock-converse-stream/errors.ts";
import { addCustomHeadersMiddleware, addResponseHeadersMiddleware } from "./bedrock-converse-stream/middleware.ts";
import {
	isAnthropicClaudeModel,
	supportsAdaptiveThinking,
	supportsToolCachePoint,
} from "./bedrock-converse-stream/model-match.ts";
import { buildAdditionalModelRequestFields } from "./bedrock-converse-stream/request-fields.ts";
import { redactProviderText } from "../utils/error-body.ts";
import {
	finalizeStreamingBlock,
	handleContentBlockDelta,
	handleContentBlockStart,
	handleContentBlockStop,
	handleMetadata,
	mapStopReason,
} from "./bedrock-converse-stream/stream-events.ts";
import type { BedrockOptions, Block } from "./bedrock-converse-stream/types.ts";

export type { BedrockOptions, BedrockThinkingDisplay } from "./bedrock-converse-stream/types.ts";

export const stream: StreamFunction<"bedrock-converse-stream", BedrockOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: TranscriptContext,
	options: BedrockOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	// Bedrock has no mid-conversation system messages; fold them into the leading prompt.
	const normalizedContext = collapseSystemMessages(context);

	(async () => {
		const output: AssistantMessage = createPendingAssistantMessage(model, "bedrock-converse-stream");
		if (options.thinkingBudgetReduction) output.thinkingBudget = options.thinkingBudgetReduction;

		const blocks = output.content as Block[];

		const config = buildBedrockClientConfig(model, options);

		// Kept outside the try so the catch can still correlate a mid-stream failure:
		// exceptions delivered as stream events carry no HTTP metadata of their own.
		let responseRequestId: string | undefined;

		try {
			const supportsStrictMode = model.compat?.supportsStrictMode ?? false;
			const client = new BedrockRuntimeClient(config);
			let observedRawResponse = false;
			if (options.onResponse) {
				addResponseHeadersMiddleware(client, options.onResponse, model, () => {
					observedRawResponse = true;
				});
			}
			const customHeaders = providerHeadersToRecord(options.headers);
			if (customHeaders) {
				addCustomHeadersMiddleware(client, customHeaders);
			}
			// Up to four checkpoints: tools (or, when split at the boundary, a second system point instead), system, the
			// last user message and, when a slot is left, the previous request's tail. Instruction checkpoints come first so a one-hour TTL never
			// follows a five-minute one.
			const { history: cacheRetention, instructions: instructionCacheRetention } = capLayeredCacheRetention(
				model,
				resolveLayeredCacheRetention(options),
			);
			const inferenceMaxTokens = options.maxTokens ?? (isAnthropicClaudeModel(model) ? model.maxTokens : undefined);
			const initialSystemMessage = getInitialSystemMessage(normalizedContext.messages);
			const splitPrompt = initialSystemMessage
				? splitSystemMessageAtBoundary(initialSystemMessage, options.instructionCacheBoundary)
				: undefined;
			const initialSystemPrompt =
				splitPrompt ?? (initialSystemMessage ? getSystemMessageText(initialSystemMessage) : undefined);
			const messages = convertMessages(normalizedContext, model, cacheRetention, options.env);
			const system = buildSystemPrompt(initialSystemPrompt, model, instructionCacheRetention, options.env);
			const toolConfig = convertToolConfig(
				getCurrentTools(normalizedContext.messages),
				options.toolChoice,
				supportsStrictMode,
				// A split prompt's base point covers the tools before it; its slot goes to the history lookback. Nova takes
				// no point on tools; the system point covers them.
				splitPrompt || !supportsToolCachePoint(model)
					? undefined
					: getCachePoint(model, instructionCacheRetention, options.env),
			);
			const historyCachePoint = getCachePoint(model, cacheRetention, options.env);
			if (historyCachePoint) {
				const usedPoints = countCachePoints(toolConfig?.tools, system, messages);
				addHistoryLookbackCachePoint(messages, historyCachePoint, usedPoints);
			}
			capNovaCachePoints(model, toolConfig?.tools, system, messages);
			let commandInput = {
				modelId: model.id,
				messages,
				system,
				inferenceConfig: {
					...(inferenceMaxTokens !== undefined && { maxTokens: inferenceMaxTokens }),
					...(options.temperature !== undefined && { temperature: options.temperature }),
				},
				toolConfig,
				additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
				...(options.requestMetadata !== undefined && { requestMetadata: options.requestMetadata }),
			};
			const nextCommandInput = await options?.onPayload?.(commandInput, model);
			if (nextCommandInput !== undefined) {
				commandInput = nextCommandInput as typeof commandInput;
			}
			assertImageRequestPayload(model, commandInput);
			const command = new ConverseStreamCommand(commandInput);

			const response = await client.send(command, { abortSignal: options.signal });
			responseRequestId = normalizeDiagnosticValue(response.$metadata.requestId);
			if (!observedRawResponse && response.$metadata.httpStatusCode !== undefined) {
				const responseHeaders: Record<string, string> = {};
				if (response.$metadata.requestId) {
					responseHeaders["x-amzn-requestid"] = response.$metadata.requestId;
				}
				await options?.onResponse?.({ status: response.$metadata.httpStatusCode, headers: responseHeaders }, model);
			}

			for await (const item of response.stream!) {
				await options.onProviderStreamEvent?.(item, model);
				if (item.messageStart) {
					if (item.messageStart.role !== ConversationRole.ASSISTANT) {
						throw new Error("Unexpected assistant message start but got user message start instead");
					}
					// Usage arrives in the metadata event after the message, so a stream dropped before it has recorded nothing.
					output.usage.lowerBound = true;
					stream.push({ type: "start", partial: output });
				} else if (item.contentBlockStart) {
					handleContentBlockStart(item.contentBlockStart, blocks, output, stream);
				} else if (item.contentBlockDelta) {
					handleContentBlockDelta(item.contentBlockDelta, blocks, output, stream);
				} else if (item.contentBlockStop) {
					handleContentBlockStop(item.contentBlockStop, blocks, output, stream);
				} else if (item.messageStop) {
					output.rawStopReason = item.messageStop.stopReason;
					const { stopReason, errorMessage } = mapStopReason(item.messageStop.stopReason);
					output.stopReason = stopReason;
					if (errorMessage) {
						output.errorMessage = redactProviderText(errorMessage);
					}
				} else if (item.metadata) {
					delete output.usage.lowerBound;
					handleMetadata(item.metadata, model, output);
				} else if (item.internalServerException) {
					throw item.internalServerException;
				} else if (item.modelStreamErrorException) {
					throw item.modelStreamErrorException;
				} else if (item.validationException) {
					throw item.validationException;
				} else if (item.throttlingException) {
					throw item.throttlingException;
				} else if (item.serviceUnavailableException) {
					throw item.serviceUnavailableException;
				}
			}

			if (options.signal?.aborted) {
				throw createAbortError();
			}

			if (output.stopReason === "pending") {
				throw new Error("Bedrock stream ended without a stop reason");
			}
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			// A stream can settle without stopping every block, so finalize here too.
			for (const block of output.content) finalizeStreamingBlock(block);
			// A stream that ended properly is the whole count, even without a metadata event.
			delete output.usage.lowerBound;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				finalizeStreamingBlock(block);
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = redactProviderText(formatBedrockError(error));
			const retryAfterMs = retryAfterMsFromError(error);
			if (retryAfterMs !== undefined) output.retryAfterMs = retryAfterMs;
			if (output.stopReason === "error") {
				appendBedrockFailureDiagnostic(output, error, responseRequestId);
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})().catch((error: unknown) => failStreamTask(stream, model, error, options?.signal));

	return stream;
};

export const streamSimple: StreamFunction<"bedrock-converse-stream", SimpleStreamOptions> = (
	model: Model<"bedrock-converse-stream">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = {
		...buildBaseOptions(model, context, options, undefined),
		toolChoice: options?.toolChoice,
	} satisfies BedrockOptions;
	if (!options?.reasoning) {
		return stream(model, context, { ...base, reasoning: undefined } satisfies BedrockOptions);
	}

	if (isAnthropicClaudeModel(model)) {
		if (supportsAdaptiveThinking(model.id, model.name)) {
			return stream(model, context, {
				...base,
				reasoning: options.reasoning,
				thinkingBudgets: options.thinkingBudgets,
			} satisfies BedrockOptions);
		}

		// Undefined means the caller did not request an output cap; let the helper use the model cap.
		// Do not coerce to 0 here, or the thinking budget would become the entire maxTokens value.
		const adjusted = adjustMaxTokensForThinking(
			base.maxTokens,
			model.maxTokens,
			options.reasoning,
			options.thinkingBudgets,
		);

		const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
		const thinkingBudget = fitClaudeThinkingBudget(adjusted.thinkingBudget, maxTokens);
		// Requested: the budget that fits the model's own output cap; a further cut came from the context clamp.
		const reduction = thinkingBudgetReduction(
			fitClaudeThinkingBudget(thinkingBudgetForLevel(options.reasoning, options.thinkingBudgets), model.maxTokens),
			thinkingBudget,
		);
		// Budget-based Claude requires at least 1024 thinking tokens. If they cannot fit, answer without thinking.
		if (thinkingBudget === 0) {
			return stream(model, context, {
				...base,
				maxTokens,
				reasoning: undefined,
				thinkingBudgetReduction: reduction,
			} satisfies BedrockOptions);
		}

		return stream(model, context, {
			...base,
			maxTokens,
			reasoning: options.reasoning,
			thinkingBudgetReduction: reduction,
			thinkingBudgets: {
				...options.thinkingBudgets,
				[clampReasoning(options.reasoning)!]: thinkingBudget,
			},
		} satisfies BedrockOptions);
	}

	return stream(model, context, {
		...base,
		reasoning: options.reasoning,
		thinkingBudgets: options.thinkingBudgets,
	} satisfies BedrockOptions);
};
