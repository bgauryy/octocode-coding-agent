import type { ChatCompletionCreateParamsStreaming } from "../src/api/ai-sdk/openai-wire-types.ts";
import { stream } from "../src/api/openai-completions.ts";
import type { OpenAICompletionsOptions, ResolvedOpenAICompletionsCompat } from "../src/api/openai-completions/types.ts";
import type { Model } from "../src/types.ts";
import type { TranscriptContext } from "../src/utils/transcript.ts";
import { completionsResponse } from "./completions-fetch-fixture.ts";

export async function captureCompletionsParams(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options: OpenAICompletionsOptions = {},
) {
	let payload: ChatCompletionCreateParamsStreaming | undefined;
	const result = await stream(model, context, {
		...options,
		apiKey: "fixture",
		fetch: async (_input, init) => {
			payload = JSON.parse(String(init?.body));
			return completionsResponse([
				{ id: "fixture", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] },
			]);
		},
	}).result();
	if (!payload) throw new Error(result.errorMessage ?? "SDK did not send a completion request");
	return payload;
}

export async function captureCompletionsMessages(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	compat?: ResolvedOpenAICompletionsCompat,
) {
	return (await captureCompletionsParams(compat ? { ...model, compat } : model, context, { cacheRetention: "none" }))
		.messages;
}
