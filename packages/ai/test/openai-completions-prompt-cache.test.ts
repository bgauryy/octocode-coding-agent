import { completionsResponse, mockCompletionsFetch } from "./completions-fetch-fixture.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";
import { withCacheCapabilities } from "../src/utils/cache-capabilities.ts";

interface CapturedRequest {
	url: string;
	headers?: Record<string, string>;
}

interface CapturedCompletionsPayload {
	prompt_cache_key?: string;
	prompt_cache_retention?: "24h" | "in-memory" | null;
	session_id?: string;
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedCompletionsPayload | undefined,
	lastRequest: undefined as CapturedRequest | undefined,
}));

mockCompletionsFetch((params: CapturedCompletionsPayload, request, url) => {
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

describe("openai-completions prompt caching", () => {
	const originalEnv = process.env.OCTOCODE_CACHE_RETENTION;

	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.lastRequest = undefined;
		delete process.env.OCTOCODE_CACHE_RETENTION;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.OCTOCODE_CACHE_RETENTION;
		} else {
			process.env.OCTOCODE_CACHE_RETENTION = originalEnv;
		}
	});

	function createModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
		const { compat: _compat, ...baseModel } = getBuiltinModel("openai", "gpt-4.1");
		// The catalog stamps the documented 24h-retention flag on the models OpenAI lists.
		return withCacheCapabilities({
			...(baseModel as Omit<Model<"openai-completions">, "api">),
			api: "openai-completions",
			...overrides,
		});
	}

	async function captureRequest(
		options?: {
			cacheRetention?: "none" | "short" | "long";
			sessionId?: string;
			promptCacheKey?: string;
			headers?: Record<string, string>;
		},
		model: Model<"openai-completions"> = createModel(),
	) {
		await streamOpenAICompletions(
			model,
			normalizeContext({
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			}),
			{ apiKey: "test-key", ...options },
		).result();

		return {
			payload: mockState.lastParams,
			headers: mockState.lastRequest?.headers ?? {},
		};
	}

	it("groups OpenAI prompt caching independently of each child's session", async () => {
		const { payload } = await captureRequest({ sessionId: "child-a", promptCacheKey: "siblings" });
		expect(payload?.prompt_cache_key).toBe("siblings");
		const disabled = await captureRequest({ sessionId: "child-b", promptCacheKey: "siblings", cacheRetention: "none" });
		expect(disabled.payload?.prompt_cache_key).toBeUndefined();
	});

	it("uses Grok chat affinity without sending OpenAI cache fields", async () => {
		const model = createModel({ provider: "xai", baseUrl: "https://api.x.ai/v1" });
		const { headers, payload } = await captureRequest({ sessionId: "grok-session" }, model);
		expect(headers["x-grok-conv-id"]).toBe("grok-session");
		expect(payload?.prompt_cache_key).toBeUndefined();
		const disabled = await captureRequest({ sessionId: "grok-session", cacheRetention: "none" }, model);
		expect(disabled.headers["x-grok-conv-id"]).toBeUndefined();
		const override = await captureRequest(
			{ sessionId: "grok-session", headers: { "x-grok-conv-id": "override" } },
			model,
		);
		expect(override.headers["x-grok-conv-id"]).toBe("override");
	});

	it("sets prompt_cache_key for direct OpenAI requests when caching is enabled", async () => {
		const { payload } = await captureRequest({ sessionId: "session-123" });

		expect(payload?.prompt_cache_key).toBe("session-123");
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("sets prompt_cache_retention to 24h for direct OpenAI requests when cacheRetention is long", async () => {
		const { payload } = await captureRequest({ cacheRetention: "long", sessionId: "session-456" });

		expect(payload?.prompt_cache_key).toBe("session-456");
		expect(payload?.prompt_cache_retention).toBe("24h");
	});

	it("sends prompt_cache_key but not prompt_cache_retention to non-OpenAI endpoints by default", async () => {
		const model = createModel({ baseUrl: "https://proxy.example.com/v1" });
		const { payload } = await captureRequest({ cacheRetention: "long", sessionId: "session-proxy" }, model);

		expect(payload?.prompt_cache_key).toBe("session-proxy");
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("sends prompt_cache_retention to a non-OpenAI endpoint whose compat declares support", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { supportsLongCacheRetention: true },
		});
		const { payload } = await captureRequest({ cacheRetention: "long", sessionId: "session-proxy" }, model);

		expect(payload?.prompt_cache_key).toBe("session-proxy");
		expect(payload?.prompt_cache_retention).toBe("24h");
	});

	it("clamps prompt_cache_key to OpenAI's 64-character limit", async () => {
		const sessionId = "x".repeat(67);
		const { payload } = await captureRequest({ sessionId });

		expect(payload?.prompt_cache_key).toBe("x".repeat(64));
	});

	it("omits prompt cache fields when cacheRetention is none", async () => {
		const { payload } = await captureRequest({ cacheRetention: "none", sessionId: "session-789" });

		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("omits prompt cache fields for non-OpenAI base URLs without compatible long retention", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { supportsLongCacheRetention: false },
		});
		const { payload } = await captureRequest({ cacheRetention: "long", sessionId: "session-proxy" }, model);

		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("honors environment cache-off for body fields and Grok affinity", async () => {
		process.env.OCTOCODE_CACHE_RETENTION = "none";
		expect((await captureRequest({ sessionId: "s" })).payload?.prompt_cache_key).toBeUndefined();
		expect(
			(await captureRequest({ sessionId: "s" }, createModel({ provider: "xai", baseUrl: "https://api.x.ai/v1" })))
				.headers["x-grok-conv-id"],
		).toBeUndefined();
	});

	it("uses OCTOCODE_CACHE_RETENTION for direct OpenAI requests", async () => {
		process.env.OCTOCODE_CACHE_RETENTION = "long";
		const { payload } = await captureRequest({ sessionId: "session-env" });

		expect(payload?.prompt_cache_key).toBe("session-env");
		expect(payload?.prompt_cache_retention).toBe("24h");
	});

	it("sends known session-affinity headers when compat.sendSessionAffinityHeaders is enabled", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionAffinityHeaders: true },
		});
		const { headers } = await captureRequest({ sessionId: "session-affinity" }, model);

		expect(headers.session_id).toBe("session-affinity");
		expect(headers["x-client-request-id"]).toBe("session-affinity");
		expect(headers["x-session-affinity"]).toBe("session-affinity");
	});

	it.each(["accounts/fireworks/models/glm-5p3", "accounts/fireworks/routers/glm-5p3-fast"] as const)(
		"sends Fireworks session affinity for %s",
		async (modelId) => {
			const model = getBuiltinModel("fireworks", modelId);
			const { headers } = await captureRequest({ sessionId: "fireworks-session" }, model);

			expect(headers["x-session-affinity"]).toBe("fireworks-session");
		},
	);

	it("sends Baseten session affinity for built-in catalog models", async () => {
		const model = getBuiltinModel("baseten", "zai-org/GLM-5.2");
		const { headers } = await captureRequest({ sessionId: "baseten-catalog-session" }, model);

		expect(headers["x-session-affinity"]).toBe("baseten-catalog-session");
		expect(headers["x-client-request-id"]).toBe("baseten-catalog-session");
	});

	it("uses OpenAI no-session format when configured", async () => {
		const model = createModel({
			compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openai-nosession" },
		});
		const { payload, headers } = await captureRequest({ sessionId: "session-nosession" }, model);

		expect(payload?.session_id).toBeUndefined();
		expect(payload?.prompt_cache_key).toBe("session-nosession");
		expect(headers.session_id).toBeUndefined();
		expect(headers["x-client-request-id"]).toBe("session-nosession");
		expect(headers["x-session-affinity"]).toBe("session-nosession");
		expect(headers["x-session-id"]).toBeUndefined();
	});

	it("uses OpenRouter session-affinity header when configured", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
		});
		const { payload, headers } = await captureRequest({ sessionId: "session-proxy" }, model);

		expect(payload?.session_id).toBeUndefined();
		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(headers["x-session-id"]).toBe("session-proxy");
		expect(headers.session_id).toBeUndefined();
		expect(headers["x-client-request-id"]).toBeUndefined();
		expect(headers["x-session-affinity"]).toBeUndefined();
	});

	it("sends OpenRouter session-affinity header by default for built-in OpenRouter models", async () => {
		const model = getBuiltinModel("openrouter", "auto");
		const { payload, headers } = await captureRequest({ sessionId: "session-openrouter" }, model);

		expect(payload?.session_id).toBeUndefined();
		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(headers["x-session-id"]).toBe("session-openrouter");
		expect(headers.session_id).toBeUndefined();
		expect(headers["x-client-request-id"]).toBeUndefined();
		expect(headers["x-session-affinity"]).toBeUndefined();
	});

	it("omits OpenRouter session-affinity data when disabled", async () => {
		const model = createModel({
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			compat: { sendSessionAffinityHeaders: false },
		});
		const { payload, headers } = await captureRequest({ sessionId: "session-openrouter" }, model);

		expect(payload?.session_id).toBeUndefined();
		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(headers["x-session-id"]).toBeUndefined();
	});

	it("omits session-affinity headers when cacheRetention is none", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionAffinityHeaders: true },
		});
		const { headers } = await captureRequest({ cacheRetention: "none", sessionId: "session-affinity" }, model);

		expect(headers.session_id).toBeUndefined();
		expect(headers["x-client-request-id"]).toBeUndefined();
		expect(headers["x-session-affinity"]).toBeUndefined();
	});

	it("lets explicit headers override generated session-affinity headers", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionAffinityHeaders: true },
		});
		const { headers } = await captureRequest(
			{
				sessionId: "session-affinity",
				headers: {
					session_id: "override-session",
					"x-client-request-id": "override-request",
					"x-session-affinity": "override-affinity",
				},
			},
			model,
		);

		expect(headers.session_id).toBe("override-session");
		expect(headers["x-client-request-id"]).toBe("override-request");
		expect(headers["x-session-affinity"]).toBe("override-affinity");
	});
});
