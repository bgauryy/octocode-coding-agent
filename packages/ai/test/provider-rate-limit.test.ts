import { describe, expect, it, vi } from "vitest";
import { isRetryableAssistantError, normalizeContext, streamSimple } from "../src/compat.ts";
import type { KnownApi, Model } from "../src/types.ts";

const apis = [
	"openai-completions",
	"openai-responses",
	"openresponses",
	"azure-openai-responses",
	"anthropic-messages",
	"mistral-conversations",
	"google-generative-ai",
	"google-vertex",
	"bedrock-converse-stream",
] as const satisfies readonly KnownApi[];

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
describe.each(apis)("%s physical requests", (api) => {
	it.each([
		{ code: "rate_limit", text: "Quota exceeded for requests per minute", sends: 2 },
		{ code: "insufficient_quota", text: "Quota exceeded for requests per minute", sends: 1 },
	])("classifies $code before recording a cooldown or retrying", async ({ code, text, sends }) => {
		const model: Model<typeof api> = {
			api,
			provider: "test",
			name: "test",
			id: "test",
			baseUrl: "https://fixture.invalid/v1",
			input: ["text"],
			reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 1024,
		};
		const fetch = vi.fn(async () =>
			Response.json({ error: { code, message: text } }, { status: 429, headers: { "retry-after-ms": "1" } }),
		);
		const onRateLimit = vi.fn();
		const onTransportRetry = vi.fn();
		const message = await streamSimple(model, context, {
			apiKey: "fixture",
			env: {
				GOOGLE_VERTEX_API_KEY: "fixture",
				AZURE_OPENAI_BASE_URL: "https://fixture.openai.azure.com/openai/v1",
				AWS_BEARER_TOKEN_BEDROCK: "fixture",
			},
			fetch,
			maxRetries: 1,
			onRateLimit,
			onTransportRetry,
		}).result();
		expect(fetch).toHaveBeenCalledTimes(sends);
		expect(onRateLimit.mock.calls).toEqual(sends === 2 ? [[1], [1]] : []);
		expect(onTransportRetry).toHaveBeenCalledTimes(sends - 1);
		expect(isRetryableAssistantError(message)).toBe(sends === 2);
	});
});
