import { googleSdkMapping } from "./ai-sdk/google-map.ts";
import { streamSdk } from "./ai-sdk/stream.ts";
import type { Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { type GoogleBaseOptions, resolveGoogleSimpleThinking } from "./ai-sdk/google-options.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface GoogleVertexOptions extends GoogleBaseOptions {
	project?: string;
	location?: string;
}

export const stream: StreamFunction<"google-vertex", GoogleVertexOptions> = (
	model: Model<"google-vertex">,
	context: TranscriptContext,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream => streamSdk(model, context, options, googleSdkMapping(model, context, options));

export const streamSimple: StreamFunction<"google-vertex", SimpleStreamOptions> = (
	model: Model<"google-vertex">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	return stream(model, context, {
		...buildBaseOptions(model, context, options, undefined),
		toolChoice: options?.toolChoice,
		thinking: resolveGoogleSimpleThinking(model, options),
	} satisfies GoogleVertexOptions);
};
