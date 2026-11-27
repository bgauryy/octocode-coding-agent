import { streamSdk } from "./ai-sdk/stream.ts";
import { mistralMapping } from "./ai-sdk/mistral-map.ts";
import type { Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import type { MistralOptions, MistralReasoningEffort } from "./mistral-conversations/types.ts";
import { buildBaseOptions, requestedReasoningEffort } from "./simple-options.ts";

export type { MistralOptions } from "./mistral-conversations/types.ts";

export const stream: StreamFunction<"mistral-conversations", MistralOptions> = (model, context, options) =>
	streamSdk(model, context, options, mistralMapping(model, context, options));

export const streamSimple: StreamFunction<"mistral-conversations", SimpleStreamOptions> = (
	model: Model<"mistral-conversations">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies MistralOptions;
	const reasoning = requestedReasoningEffort(model, options);
	const effortMap = model.reasoning ? model.thinkingLevelMap : undefined;
	const reasoningEffort = effortMap
		? reasoning
			? (effortMap[reasoning] ?? "high")
			: (effortMap.off ?? undefined)
		: undefined;
	return stream(model, context, {
		...base,
		promptMode: model.reasoning && !effortMap && reasoning ? "reasoning" : undefined,
		reasoningEffort: reasoningEffort as MistralReasoningEffort | undefined,
	});
};
