import type { Model } from "../../types.ts";
import { resolveCacheAffinityId } from "../../utils/cache-policy.ts";
import type { TranscriptContext } from "../../utils/transcript.ts";
import { createClient } from "../openai-completions/client.ts";
import type { OpenAICompletionsOptions } from "../openai-completions/types.ts";

export function completionsFetch(
	model: Model<"openai-completions">,
	context: TranscriptContext,
	options: OpenAICompletionsOptions,
	apiKey: string,
): typeof globalThis.fetch {
	const client = createClient(
		model,
		context,
		apiKey,
		options.headers,
		options.fetch,
		resolveCacheAffinityId(options),
		undefined,
		options.env,
	);
	return async (_input, init) =>
		(options.fetch ?? globalThis.fetch)(client.url, {
			...init,
			headers: client.headers,
		});
}
