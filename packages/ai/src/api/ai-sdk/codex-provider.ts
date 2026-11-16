import { createOpenAI } from "@ai-sdk/openai";
import type { Model, StreamOptions } from "../../types.ts";
import { resolveCacheAffinityId } from "../../utils/cache-policy.ts";
import { clampOpenAIPromptCacheKey } from "../openai-prompt-cache.ts";
import { buildSSEHeaders, extractAccountId, resolveCodexUrl } from "../openai-codex-responses/request.ts";

export function codexSdkModel(
	model: Model<"openai-codex-responses">,
	options: StreamOptions,
	fetch: typeof globalThis.fetch,
) {
	const token = options.apiKey;
	if (!token) throw new Error(`No API key for provider: ${model.provider}`);
	const headers = buildSSEHeaders(
		model.headers,
		options.headers,
		extractAccountId(token),
		token,
		clampOpenAIPromptCacheKey(resolveCacheAffinityId(options)),
	);
	return createOpenAI({
		apiKey: token,
		baseURL: resolveCodexUrl(model.baseUrl).replace(/\/responses$/, ""),
		headers: Object.fromEntries(headers),
		fetch,
	}).responses(model.id);
}
