import { streamSdk } from "./ai-sdk/stream.ts";
import { googleSdkMapping } from "./ai-sdk/google-map.ts";
import type { Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { type GoogleBaseOptions, resolveGoogleSimpleThinking } from "./ai-sdk/google-options.ts";
import { buildBaseOptions } from "./simple-options.ts";

export type GoogleOptions = GoogleBaseOptions;

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: GoogleOptions,
): AssistantMessageEventStream => streamSdk(model, context, options, googleSdkMapping(model, context, options));

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	return stream(model, context, {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
		thinking: resolveGoogleSimpleThinking(model, options),
	} satisfies GoogleOptions);
};
