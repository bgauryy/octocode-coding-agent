import { streamSdk } from "./ai-sdk/stream.ts";
import { responsesMapping } from "./ai-sdk/responses-map.ts";
import { createRequestHeaders } from "./openai-responses/request.ts";
import { resolveCacheAffinityId } from "../utils/cache-policy.ts";
import type { Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import { getClientApiKey } from "../utils/headers.ts";
import { resolveTranscript } from "../utils/transcript.ts";
import { getCompat } from "./openai-responses/compat.ts";
import type { OpenAIResponsesOptions } from "./openai-responses/types.ts";
import { buildBaseOptions, requestedReasoningEffort } from "./simple-options.ts";

export type { OpenAIResponsesOptions } from "./openai-responses/types.ts";

export const stream: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
) => {
	const compat = getCompat(model);
	const normalized = resolveTranscript(context, compat.supportsMidConvoSystemMessages);
	const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
	const sdkOptions = {
		...options,
		apiKey,
		headers: {
			...createRequestHeaders(
				model,
				normalized,
				apiKey,
				options?.headers,
				resolveCacheAffinityId(options),
				options?.env,
			),
			...options?.headers,
		},
		maxTokens: compat.supportsMaxOutputTokens ? options?.maxTokens : undefined,
		temperature: compat.supportsTemperature ? options?.temperature : undefined,
	};
	return streamSdk(model, normalized, sdkOptions, responsesMapping(model, sdkOptions, normalized));
};

export const streamSimple: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) =>
	stream(model, context, {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
		reasoningEffort: requestedReasoningEffort(model, options),
	} satisfies OpenAIResponsesOptions);
