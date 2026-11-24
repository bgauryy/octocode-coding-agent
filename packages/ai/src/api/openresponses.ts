import type { AssistantMessageEvent, Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { failStreamTask } from "./lazy.ts";
import { stream as streamResponses, streamSimple as streamSimpleResponses } from "./openai-responses.ts";
import type { OpenAIResponsesOptions } from "./openai-responses/types.ts";

export type { OpenAIResponsesOptions as OpenResponsesOptions } from "./openai-responses/types.ts";

/**
 * OpenResponses (https://www.openresponses.org) is the open specification of the OpenAI Responses API: the same
 * `POST {baseUrl}/responses` request, streaming events, items, tools and usage. The transport and contract are therefore
 * the OpenAI Responses implementation, run on the model's own base URL and credentials. Only the API name differs:
 * the model, caches and the messages it produces keep `openresponses` as their API.
 */
const API = "openresponses";

function asResponsesModel(model: Model<typeof API>): Model<"openai-responses"> {
	return { ...model, api: "openai-responses" } as unknown as Model<"openai-responses">;
}

/** Forwards the delegate's events, naming this API on every message they carry. */
function relabel(source: AssistantMessageEventStream, model: Model<typeof API>): AssistantMessageEventStream {
	const target = new AssistantMessageEventStream();
	const label = (event: AssistantMessageEvent): AssistantMessageEvent => {
		const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
		message.api = API;
		return event;
	};
	void (async () => {
		for await (const event of source) target.push(label(event));
		target.end(await source.result());
	})().catch((error: unknown) => failStreamTask(target, model, error));
	return target;
}

export const stream: StreamFunction<typeof API, OpenAIResponsesOptions> = (
	model: Model<typeof API>,
	context: TranscriptContext,
	options?: OpenAIResponsesOptions,
) => relabel(streamResponses(asResponsesModel(model), context, options), model);

export const streamSimple: StreamFunction<typeof API, SimpleStreamOptions> = (
	model: Model<typeof API>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => relabel(streamSimpleResponses(asResponsesModel(model), context, options), model);
