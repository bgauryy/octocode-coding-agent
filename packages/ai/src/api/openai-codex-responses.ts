import type { Model, SimpleStreamOptions, StreamFunction, TranscriptContext } from "../types.ts";
import { resolveTranscript } from "../utils/transcript.ts";
import { streamSdk } from "./ai-sdk/stream.ts";
import { buildSSEHeaders, extractAccountId } from "./openai-codex-responses/request.ts";
import { resolveCacheAffinityId } from "../utils/cache-policy.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import { codexMapping } from "./ai-sdk/codex-map.ts";
import { buildBaseOptions, requestedReasoningEffort } from "./simple-options.ts";
import type { OpenAICodexResponsesOptions } from "./openai-codex-responses/types.ts";

export type { OpenAICodexResponsesOptions } from "./openai-codex-responses/types.ts";

export const stream: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
	model: Model<"openai-codex-responses">,
	context: TranscriptContext,
	options: OpenAICodexResponsesOptions = {},
) => {
	const token = options.apiKey;
	if (!token) throw new Error(`No API key for provider: ${model.provider}`);
	const normalized = resolveTranscript(context, model.compat?.supportsMidConvoSystemMessages);
	const fetch: typeof globalThis.fetch = (input, init) => {
		const headers = buildSSEHeaders(
			model.headers,
			options.headers,
			extractAccountId(token),
			token,
			clampOpenAIPromptCacheKey(resolveCacheAffinityId(options)),
		);
		const merged = new Headers(init?.headers);
		for (const [name, value] of headers) merged.set(name, value);
		return (options.fetch ?? globalThis.fetch)(input, { ...init, headers: merged });
	};
	return streamSdk(model, normalized, { ...options, fetch }, codexMapping(model, normalized, options));
};

export const streamSimple: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (model, context, options) =>
	stream(model, context, {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
		reasoningEffort: requestedReasoningEffort(model, options),
	});
