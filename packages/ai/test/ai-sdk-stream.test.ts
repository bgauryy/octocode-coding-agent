import { describe, expect, it, vi } from "vitest";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as completions } from "../src/api/openai-completions.ts";
import { stream as google } from "../src/api/google-generative-ai.ts";
import { stream as vertex } from "../src/api/google-vertex.ts";
import type { Api, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function model<T extends Api>(api: T, provider: string, baseUrl: string): Model<T> {
	return {
		api,
		provider,
		baseUrl,
		id: "test-model",
		name: "Test",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}
function sse(events: unknown[]) {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream", "x-request-id": "test-request" },
	});
}
const context = normalizeContext({
	systemPrompt: "Be helpful",
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
});
const googleEvents = [
	{
		candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP", index: 0 }],
		usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12, cachedContentTokenCount: 3 },
		responseId: "google-response",
	},
];

describe("shared AI SDK transport", () => {
	it("streams Anthropic text without changing its API identity or API version", async () => {
		const request = vi.fn<typeof globalThis.fetch>(async (_input, _init) =>
			sse([
				{
					type: "message_start",
					message: {
						id: "anthropic-response",
						type: "message",
						role: "assistant",
						model: "test-model",
						content: [],
						stop_reason: null,
						stop_sequence: null,
						usage: { input_tokens: 10, output_tokens: 0 },
					},
				},
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
				{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
				{ type: "message_stop" },
			]),
		);
		const result = await anthropic(
			model("anthropic-messages", "anthropic", "https://proxy.invalid/anthropic"),
			context,
			{
				apiKey: "test-key",
				cacheRetention: "none",
				fetch: request,
			},
		).result();
		expect(result.errorMessage).toBeUndefined();
		expect(result).toMatchObject({
			api: "anthropic-messages",
			stopReason: "stop",
			content: [{ type: "text", text: "hello" }],
		});
		expect(String(request.mock.calls[0][0])).toBe("https://proxy.invalid/anthropic/v1/messages");
		expect(new Headers(request.mock.calls[0][1]?.headers).get("anthropic-version")).toBe("2023-06-01");
	});

	it.each(["https://proxy.invalid/google", "https://proxy.invalid/google/v1beta", "https://proxy.invalid/google/v1"])(
		"keeps Google version semantics at %s",
		async (baseUrl) => {
			const request = vi.fn<typeof globalThis.fetch>(async (_input, _init) => sse(googleEvents));
			const result = await google(model("google-generative-ai", "google", baseUrl), context, {
				apiKey: "test-key",
				fetch: request,
			}).result();
			expect(result.errorMessage).toBeUndefined();
			expect(result).toMatchObject({
				api: "google-generative-ai",
				stopReason: "stop",
				content: [{ type: "text", text: "hello" }],
				usage: { input: 7, output: 2, cacheRead: 3, totalTokens: 12 },
			});
			const versioned = /\/v1(?:beta)?$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1beta`;
			expect(String(request.mock.calls[0][0])).toBe(`${versioned}/models/test-model:streamGenerateContent?alt=sse`);
		},
	);

	it("keeps Vertex Express on v1 and its API key off the URL", async () => {
		const request = vi.fn<typeof globalThis.fetch>(async (_input, _init) => sse(googleEvents));
		const result = await vertex(model("google-vertex", "google-vertex", ""), context, {
			apiKey: "test-key",
			fetch: request,
		}).result();
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("stop");
		expect(String(request.mock.calls[0][0])).toBe(
			"https://aiplatform.googleapis.com/v1/publishers/google/models/test-model:streamGenerateContent?alt=sse",
		);
		expect(new Headers(request.mock.calls[0][1]?.headers).get("x-goog-api-key")).toBe("test-key");
	});

	it("preserves raw Chat events while normalizing null chunks and cache-write usage", async () => {
		const events = [
			null,
			{ id: "chat-response", choices: [{ delta: { reasoning: "think" }, finish_reason: null }] },
			{
				choices: [
					{
						delta: { content: "hello" },
						finish_reason: "stop",
						usage: {
							prompt_tokens: 20,
							completion_tokens: 2,
							prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 4 },
						},
					},
				],
			},
		];
		const seen: unknown[] = [];
		const request = vi.fn<typeof globalThis.fetch>(async (_input, _init) => sse(events));
		const result = await completions(model("openai-completions", "openai", "https://api.openai.com/v1"), context, {
			apiKey: "test-key",
			fetch: request,
			onProviderStreamEvent: (event) => {
				seen.push(event);
			},
		}).result();
		expect(result.errorMessage).toBeUndefined();
		expect(result).toMatchObject({
			stopReason: "stop",
			usage: { input: 13, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 22 },
		});
		expect(result.content).toEqual([
			{ type: "thinking", thinking: "think", thinkingSignature: "reasoning" },
			{ type: "text", text: "hello" },
		]);
		expect(seen).toEqual(events);
	});

	it("reports a pre-aborted request without fetching", async () => {
		const controller = new AbortController();
		controller.abort();
		const request = vi.fn();
		const result = await completions(model("openai-completions", "openai", "https://api.openai.com/v1"), context, {
			apiKey: "test-key",
			fetch: request,
			signal: controller.signal,
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(request).not.toHaveBeenCalled();
	});
});
