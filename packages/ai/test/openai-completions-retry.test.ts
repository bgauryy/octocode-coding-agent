import { completionsResponse, mockCompletionsFetch } from "./completions-fetch-fixture.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({
	requestOptions: [] as unknown[],
	requestErrors: [] as Array<Error & { status?: number; headers?: Headers }>,
}));

mockCompletionsFetch((_params: unknown, request) => {
	mockState.requestOptions.push(request);
	const error = mockState.requestErrors.shift();
	if (error)
		return new Response(error.message, {
			status: error.status ?? 500,
			statusText: error.message,
			headers: error.headers,
		});
	return completionsResponse([
		{ id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "ok" } }] },
		{ id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	]);
});

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context = normalizeContext({
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
});

async function consume(options?: { maxRetries?: number; maxRetryDelayMs?: number }) {
	const stream = streamOpenAICompletions(model, context, { apiKey: "test", ...options });
	for await (const _event of stream) {
		void _event;
	}
	return stream.result();
}

describe("openai-completions provider retries", () => {
	beforeEach(() => {
		mockState.requestOptions = [];
		mockState.requestErrors = [];
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("makes one HTTP attempt by default", async () => {
		await consume();
		expect(mockState.requestOptions).toEqual([expect.objectContaining({ method: "POST" })]);
	});

	it("copies the provider's retry-after onto the error message when retries are off", async () => {
		mockState.requestErrors = [
			Object.assign(new Error("rate limited"), { status: 429, headers: new Headers({ "retry-after": "7" }) }),
		];

		const result = await consume();

		expect(result.stopReason).toBe("error");
		expect(result.retryAfterMs).toBe(7000);
	});

	it("honors the configured retry budget without hidden SDK retries", async () => {
		vi.useFakeTimers();
		mockState.requestErrors = [
			Object.assign(new Error("rate limited"), {
				status: 429,
				headers: new Headers({ "retry-after-ms": "100" }),
			}),
			Object.assign(new Error("server error"), {
				status: 500,
				headers: new Headers({ "retry-after-ms": "100" }),
			}),
		];

		const result = consume({ maxRetries: 2, maxRetryDelayMs: 100 });
		await vi.advanceTimersByTimeAsync(0);
		expect(mockState.requestOptions).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(99);
		expect(mockState.requestOptions).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(mockState.requestOptions).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(99);
		expect(mockState.requestOptions).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		await result;

		expect(mockState.requestOptions).toEqual([
			expect.objectContaining({ method: "POST" }),
			expect.objectContaining({ method: "POST" }),
			expect.objectContaining({ method: "POST" }),
		]);
	});

	it("fails immediately when a provider-requested retry delay exceeds the limit", async () => {
		mockState.requestErrors = [
			Object.assign(new Error("rate limited"), {
				status: 429,
				headers: new Headers({ "retry-after": "277403" }),
			}),
		];

		const result = await consume({ maxRetries: 2, maxRetryDelayMs: 1000 });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Server requested 277403s retry delay (max: 1s)");
		expect(result.errorMessage).toContain("rate limited");
		expect(mockState.requestOptions).toEqual([expect.objectContaining({ method: "POST" })]);
	});
});
