import { streamSdk } from "./ai-sdk/stream.ts";
import { completionsMapping } from "./ai-sdk/completions-map.ts";
import { completionsFetch } from "./ai-sdk/completions-fetch.ts";
import type { Model, SimpleStreamOptions, StreamFunction } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { getClientApiKey } from "../utils/headers.ts";
import { resolveTranscript, type TranscriptContext } from "../utils/transcript.ts";
import { getCompat } from "./openai-completions/compat.ts";
import type { OpenAICompletionsOptions } from "./openai-completions/types.ts";
import { buildBaseOptions, requestedReasoningEffort } from "./simple-options.ts";

export type { OpenAICompletionsOptions } from "./openai-completions/types.ts";

export const stream: StreamFunction<"openai-completions", OpenAICompletionsOptions> = (
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options?: OpenAICompletionsOptions,
): AssistantMessageEventStream => {
	const normalized = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);
	const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
	return streamSdk(
		model,
		normalized,
		{ ...options, apiKey, fetch: completionsFetch(model, normalized, options ?? {}, apiKey) },
		completionsMapping(model, normalized, options),
	);
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
	return stream(model, context, {
		...base,
		reasoningEffort: requestedReasoningEffort(model, options),
		thinkingBudgets: options?.thinkingBudgets,
	});
};
