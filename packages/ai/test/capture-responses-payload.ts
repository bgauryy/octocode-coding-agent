import { stream } from "../src/api/openai-responses.ts";
import type { OpenAIResponsesOptions } from "../src/api/openai-responses/types.ts";
import type { Model, TranscriptContext } from "../src/types.ts";

export async function captureResponsesPayload<T>(
	model: Model<"openai-responses">,
	context: TranscriptContext,
	options: OpenAIResponsesOptions,
): Promise<T> {
	let payload: T | undefined;
	await stream(model, context, {
		...options,
		fetch: async (_input, init) => {
			payload = JSON.parse(String(init?.body)) as T;
			return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		},
	}).result();
	if (payload === undefined) throw new Error("Responses SDK did not send a request");
	return payload;
}
