import { completionsResponse, mockCompletionsFetch } from "./completions-fetch-fixture.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";

// Empty tools arrays must NOT be serialized as `tools: []` — some OpenAI-compatible
// backends (e.g. DashScope / Aliyun Qwen via compatible-mode) reject the request with
// `"[] is too short - 'tools'"` (HTTP 400) when `--no-tools` produces an empty array.

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	lastRequest: undefined as unknown,
}));

mockCompletionsFetch((params: unknown, request, url) => {
	mockState.lastRequest = { url, headers: Object.fromEntries(new Headers(request.headers)) };
	mockState.lastParams = params;
	const stream = {
		async *[Symbol.asyncIterator]() {
			yield {
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			};
		},
	};
	return completionsResponse(stream);
});

describe("openai-completions empty tools handling", () => {
	afterEach(() => vi.unstubAllEnvs());

	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.lastRequest = undefined;
	});

	it("omits tools field when context.tools is an empty array", async () => {
		const { compat: _compat, ...baseModel } = getBuiltinModel("openai", "gpt-4o-mini");
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
				tools: [],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { tools?: unknown };
		expect("tools" in (params as object)).toBe(false);
	});

	it("omits tools field when context.tools is undefined", async () => {
		const { compat: _compat, ...baseModel } = getBuiltinModel("openai", "gpt-4o-mini");
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { tools?: unknown };
		expect("tools" in (params as object)).toBe(false);
	});

	it("sends default maxTokens", async () => {
		const { compat: _compat, ...baseModel } = getBuiltinModel("openai", "gpt-4o-mini");
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { max_tokens?: number; max_completion_tokens?: number };
		expect(params.max_tokens).toBeUndefined();
		expect(params.max_completion_tokens).toBe(model.maxTokens);
	});

	it("sends explicit maxTokens", async () => {
		const { compat: _compat, ...baseModel } = getBuiltinModel("openai", "gpt-4o-mini");
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", maxTokens: 1234 },
		).result();

		const params = mockState.lastParams as { max_tokens?: number; max_completion_tokens?: number };
		expect(params.max_tokens).toBeUndefined();
		expect(params.max_completion_tokens).toBe(1234);
	});

	it("clamps default maxTokens to remaining context", async () => {
		const { compat: _compat, ...baseModel } = getBuiltinModel("openai", "gpt-4o-mini");
		const model = { ...baseModel, api: "openai-completions", contextWindow: 10000, maxTokens: 8000 } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "x".repeat(8000), timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { max_tokens?: number; max_completion_tokens?: number };
		expect(params.max_tokens).toBeUndefined();
		// 8000 characters estimate to 2667 tokens at 3 characters per token: 10000 - 2667 - 4096.
		expect(params.max_completion_tokens).toBe(3237);
	});

	it("clamps explicit maxTokens to remaining context", async () => {
		const { compat: _compat, ...baseModel } = getBuiltinModel("openai", "gpt-4o-mini");
		const model = { ...baseModel, api: "openai-completions", contextWindow: 10000, maxTokens: 8000 } as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "x".repeat(8000), timestamp: Date.now() }],
			},
			{ apiKey: "test", maxTokens: 7000 },
		).result();

		const params = mockState.lastParams as { max_tokens?: number; max_completion_tokens?: number };
		expect(params.max_tokens).toBeUndefined();
		// 8000 characters estimate to 2667 tokens at 3 characters per token: 10000 - 2667 - 4096.
		expect(params.max_completion_tokens).toBe(3237);
	});

	it("uses conservative OpenAI-compatible fields for Cloudflare AI Gateway /compat models", async () => {
		vi.stubEnv("CLOUDFLARE_API_KEY", "cf-token");
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id");
		vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gateway-id");
		const model = getBuiltinModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");

		await streamSimple(
			model,
			{
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ maxTokens: 1234, reasoning: "high" },
		).result();

		const params = mockState.lastParams as {
			messages: Array<{ role: string }>;
			max_tokens?: number;
			max_completion_tokens?: number;
			reasoning_effort?: string;
			store?: boolean;
		};
		expect(params.messages[0].role).toBe("system");
		expect(params.max_tokens).toBe(1234);
		expect(params.max_completion_tokens).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
		expect(params.store).toBeUndefined();

		const request = mockState.lastRequest as {
			url?: string;
			headers?: Record<string, unknown>;
		};
		expect(request.url).toBe("https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/compat/chat/completions");
		expect(request.headers?.authorization).toBeUndefined();
		expect(request.headers?.["cf-aig-authorization"]).toBe("Bearer cf-token");
	});

	it("resolves Cloudflare AI Gateway base URL through provider auth", async () => {
		vi.stubEnv("CLOUDFLARE_API_KEY", "cf-token");
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id");
		vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gateway-id");
		const model = getBuiltinModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");

		await streamSimple(model, {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		}).result();

		const request = mockState.lastRequest as { url?: string };
		expect(request.url).toBe("https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/compat/chat/completions");
	});

	it("preserves inline upstream Authorization for Cloudflare AI Gateway BYOK requests", async () => {
		vi.stubEnv("CLOUDFLARE_API_KEY", "cf-token");
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id");
		vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gateway-id");
		const model = getBuiltinModel("cloudflare-ai-gateway", "gpt-5.1");
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n', {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);

		const result = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ headers: { Authorization: "Bearer upstream-token" }, fetch },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(fetch).toHaveBeenCalledOnce();
		const [url, options] = fetch.mock.calls[0];
		expect(String(url)).toBe("https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/openai/responses");
		const headers = new Headers(options?.headers);
		expect(headers.get("Authorization")).toBe("Bearer upstream-token");
		expect(headers.get("cf-aig-authorization")).toBe("Bearer cf-token");
	});

	it("sends session affinity headers for Workers AI through Cloudflare AI Gateway", async () => {
		vi.stubEnv("CLOUDFLARE_API_KEY", "cf-token");
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account-id");
		vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "gateway-id");
		const workersModel = getBuiltinModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6");

		await streamSimple(
			workersModel,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ sessionId: "session-1" },
		).result();

		const request = mockState.lastRequest as { headers?: Record<string, string> };
		expect(request.headers?.session_id).toBe("session-1");
		expect(request.headers?.["x-client-request-id"]).toBe("session-1");
		expect(request.headers?.["x-session-affinity"]).toBe("session-1");
	});

	it("still emits tools: [] for Anthropic/LiteLLM proxy when conversation has tool history", async () => {
		const { compat: _compat, ...baseModel } = getBuiltinModel("openai", "gpt-4o-mini");
		const model = { ...baseModel, api: "openai-completions" } as const;

		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "use the tool", timestamp: Date.now() },
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "t1",
								name: "noop",
								arguments: {},
							},
						],
						stopReason: "toolUse",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						api: "openai-completions",
						provider: "openai",
						model: "gpt-4o-mini",
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "t1",
						toolName: "noop",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
				tools: [],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { tools?: unknown[] };
		expect(Array.isArray(params.tools)).toBe(true);
		expect(params.tools).toEqual([]);
	});
});
