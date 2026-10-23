import { createPendingAssistantMessage } from "../utils/assistant-message.ts";
import { AzureOpenAI } from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { resolveCacheRetention } from "../utils/cache-policy.ts";
import { clampThinkingLevel } from "../models.ts";
import type { AssistantMessage, Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { failStreamTask } from "./lazy.ts";
import { getPiUserAgent } from "../utils/pi-user-agent.ts";
import { getDeclaredTools, resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import { type AzureEndpointOptions, resolveAzureConfig, resolveDeploymentName } from "./azure-openai-config.ts";
import { createGrammarToolInputProperties } from "./constrained-sampling.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { requestOpenAISdkStream } from "./openai-sdk-request.ts";
import {
	assertResponsesStreamCompleted,
	convertResponsesMessages,
	convertResponsesTools,
	getResponsesToolSupport,
	processResponsesStream,
	stripResponsesStreamScratch,
} from "./openai-responses-shared.ts";
import { buildBaseOptions, resolveSamplingParams } from "./simple-options.ts";

const AZURE_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode", "azure"]);
// OpenAI Responses rejects max_output_tokens below 16.
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

function formatAzureOpenAIError(error: unknown): string {
	return formatProviderError(normalizeProviderError(error), "Azure OpenAI API error");
}

// Azure OpenAI Responses-specific options
export interface AzureOpenAIResponsesOptions extends AzureEndpointOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	toolChoice?: ResponseCreateParamsStreaming["tool_choice"];
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
}

/**
 * Generate function for Azure OpenAI Responses API
 */
export const stream: StreamFunction<"azure-openai-responses", AzureOpenAIResponsesOptions> = (
	model: Model<"azure-openai-responses">,
	context: TranscriptContext,
	options?: AzureOpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages);

	// Start async processing
	(async () => {
		const deploymentName = resolveDeploymentName(model, options);

		const output: AssistantMessage = createPendingAssistantMessage(model, "azure-openai-responses");

		try {
			// Create Azure OpenAI client
			const apiKey = options?.apiKey;
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const client = createClient(model, apiKey, options);
			const grammarToolInputProperties = createGrammarToolInputProperties(
				getDeclaredTools(normalizedContext.messages),
				model.compat?.supportsOpenAIGrammarTools ?? false,
			);
			let params = buildParams(model, normalizedContext, options, deploymentName, grammarToolInputProperties);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			const openaiStream = await requestOpenAISdkStream(model, options, (requestOptions) =>
				client.responses.create(params, requestOptions),
			);
			stream.push({ type: "start", partial: output });

			await processResponsesStream(openaiStream, output, stream, model, {
				onProviderStreamEvent: options?.onProviderStreamEvent,
				grammarToolInputProperties,
			});

			assertResponsesStreamCompleted(output, options?.signal, "Azure OpenAI Responses");

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			stripResponsesStreamScratch(output);
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatAzureOpenAIError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})().catch((error: unknown) => failStreamTask(stream, model, error, options?.signal));

	return stream;
};

export const streamSimple: StreamFunction<"azure-openai-responses", SimpleStreamOptions> = (
	model: Model<"azure-openai-responses">,
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
	} satisfies AzureOpenAIResponsesOptions;
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return stream(model, context, {
		...base,
		reasoningEffort,
	} satisfies AzureOpenAIResponsesOptions);
};

function createClient(model: Model<"azure-openai-responses">, apiKey: string, options?: AzureOpenAIResponsesOptions) {
	const headers = { "User-Agent": getPiUserAgent(), ...model.headers };

	if (options?.headers) {
		Object.assign(headers, options.headers);
	}

	const { baseUrl, apiVersion } = resolveAzureConfig(model, options);

	return new AzureOpenAI({
		apiKey,
		apiVersion,
		dangerouslyAllowBrowser: true,
		fetch: options?.fetch,
		defaultHeaders: headers,
		baseURL: baseUrl,
	});
}

function buildParams(
	model: Model<"azure-openai-responses">,
	context: TranscriptContext,
	options: AzureOpenAIResponsesOptions | undefined,
	deploymentName: string,
	grammarToolInputProperties: ReadonlyMap<string, string> = createGrammarToolInputProperties(
		getDeclaredTools(context.messages),
		model.compat?.supportsOpenAIGrammarTools ?? false,
	),
) {
	const supportsAdditionalTools = model.compat?.supportsAdditionalTools ?? false;
	const supportsToolSearch = model.compat?.supportsToolSearch ?? false;
	const transcriptTools = resolveTranscriptTools(
		context.messages,
		getResponsesToolSupport({
			supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
			supportsAdditionalTools,
			supportsToolSearch,
		}),
	);
	const messages = convertResponsesMessages(model, context, AZURE_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		supportsMidConvoSystemMessages: model.compat?.supportsMidConvoSystemMessages ?? false,
		supportsAdditionalTools,
		supportsToolSearch,
		toolOptions: {
			supportsStrictMode: model.compat?.supportsStrictMode ?? true,
			supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		},
	});

	const params: ResponseCreateParamsStreaming = {
		model: deploymentName,
		input: messages,
		stream: true,
		prompt_cache_key:
			resolveCacheRetention(options?.cacheRetention, options?.env) === "none"
				? undefined
				: clampOpenAIPromptCacheKey(options?.sessionId),
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (transcriptTools.requestTools.length > 0) {
		params.tools = convertResponsesTools(transcriptTools.requestTools, {
			supportsStrictMode: model.compat?.supportsStrictMode ?? true,
			supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		});
	}
	if (options?.toolChoice !== undefined) {
		params.tool_choice = options.toolChoice;
	}

	const reasoningEffort = options?.reasoningEffort ?? (options?.reasoningSummary ? "medium" : undefined);
	if (model.reasoning) {
		if (reasoningEffort) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: reasoningEffort;
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
	}

	// Last so model and request sampling parameters override named request fields.
	const samplingParams = resolveSamplingParams(model, reasoningEffort ?? "off", options?.samplingParams);
	if (samplingParams) {
		Object.assign(params, samplingParams);
	}

	return params;
}
