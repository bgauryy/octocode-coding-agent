import { stream as streamAzure } from "../src/api/azure-openai-responses.ts";
import { stream } from "../src/api/openai-responses.ts";
import type { OpenAIResponsesOptions } from "../src/api/openai-responses/types.ts";
import type { Model, TranscriptContext } from "../src/types.ts";

export async function captureResponsesPayload<T>(
	model: Model<"openai-responses"> | Model<"azure-openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions,
): Promise<T> {
	let payload: T | undefined;
	const capture = {
		...options,
		fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
			payload = JSON.parse(String(init?.body)) as T;
			return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		},
	};
	await (
		model.api === "azure-openai-responses" ? streamAzure(model, context, capture) : stream(model, context, capture)
	).result();
	if (payload === undefined) throw new Error("Responses SDK did not send a request");
	return payload;
}

/** The `input` items a Responses request replays for `context`, built through the real request path. */
export async function replayedResponsesInput(
	model: Model<"openai-responses"> | Model<"azure-openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions = {},
): Promise<Array<Record<string, unknown>>> {
	const payload = await captureResponsesPayload<{ input: Array<Record<string, unknown>> }>(model, context, {
		apiKey: "sk-test",
		...options,
	});
	return payload.input;
}
