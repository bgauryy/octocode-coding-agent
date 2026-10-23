import { BedrockRuntimeClient, ConversationRole, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import type { AssistantMessage, Model, SimpleStreamOptions, StreamFunction } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { failStreamTask } from "./lazy.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
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
} from "./simple-options.ts";
import { resolveCacheRetention } from "../utils/cache-policy.ts";
import { buildBedrockClientConfig } from "./bedrock-converse-stream/client-config.ts";
import { buildSystemPrompt, convertMessages, convertToolConfig } from "./bedrock-converse-stream/convert.ts";
import {
	appendBedrockFailureDiagnostic,
	formatBedrockError,
	normalizeDiagnosticValue,
} from "./bedrock-converse-stream/errors.ts";
import { addCustomHeadersMiddleware, addResponseHeadersMiddleware } from "./bedrock-converse-stream/middleware.ts";
import { isAnthropicClaudeModel, supportsAdaptiveThinking } from "./bedrock-converse-stream/model-support.ts";
import { buildAdditionalModelRequestFields } from "./bedrock-converse-stream/request-fields.ts";
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
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "bedrock-converse-stream",
			provider: model.provider,
			model: model.id,
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
			const cacheRetention = resolveCacheRetention(options.cacheRetention, options.env);
			const inferenceMaxTokens = options.maxTokens ?? (isAnthropicClaudeModel(model) ? model.maxTokens : undefined);
			const initialSystemMessage = getInitialSystemMessage(normalizedContext.messages);
			const initialSystemPrompt = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : undefined;
			let commandInput = {
				modelId: model.id,
				messages: convertMessages(normalizedContext, model, cacheRetention, options.env),
				system: buildSystemPrompt(initialSystemPrompt, model, cacheRetention, options.env),
				inferenceConfig: {
					...(inferenceMaxTokens !== undefined && { maxTokens: inferenceMaxTokens }),
					...(options.temperature !== undefined && { temperature: options.temperature }),
				},
				toolConfig: convertToolConfig(
					getCurrentTools(normalizedContext.messages),
					options.toolChoice,
					supportsStrictMode,
				),
				additionalModelRequestFields: buildAdditionalModelRequestFields(model, options),
				...(options.requestMetadata !== undefined && { requestMetadata: options.requestMetadata }),
			};
			const nextCommandInput = await options?.onPayload?.(commandInput, model);
			if (nextCommandInput !== undefined) {
				commandInput = nextCommandInput as typeof commandInput;
			}
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
						output.errorMessage = errorMessage;
					}
				} else if (item.metadata) {
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
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Bedrock stream ended without a stop reason");
			}
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			// A stream can settle without stopping every block, so finalize here too.
			for (const block of output.content) finalizeStreamingBlock(block);
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				finalizeStreamingBlock(block);
			}
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatBedrockError(error);
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
		const thinkingBudget = Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024));
		// Budget-based Claude requires at least 1024 thinking tokens. If they cannot fit, answer without thinking.
		if (thinkingBudget < 1024) {
			return stream(model, context, { ...base, maxTokens, reasoning: undefined } satisfies BedrockOptions);
		}

		return stream(model, context, {
			...base,
			maxTokens,
			reasoning: options.reasoning,
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
