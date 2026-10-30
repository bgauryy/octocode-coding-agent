import { describe, expect, it } from "vitest";
import { stream } from "../src/api/mistral-conversations.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";

const model = getBuiltinModel("mistral", "mistral-large-latest");
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
const completed = () =>
	new Response(
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 16 } } })}\n\ndata: [DONE]\n\n`,
	);

describe("Mistral protocol regressions", () => {
	it("cancels a stalled HTTP error body when the request deadline expires", async () => {
		let cancelled = false;
		const result = await stream(model, context, {
			apiKey: "test",
			timeoutMs: 5,
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							cancelled = true;
						},
					}),
					{ status: 503 },
				),
		}).result();
		expect(result.errorMessage).toContain("response headers timed out");
		expect(cancelled).toBe(true);
	});
	it("times out an uncooperative fetch and cancels its late response body", async () => {
		let deliver!: (response: Response) => void;
		const response = new Promise<Response>((resolve) => {
			deliver = resolve;
		});
		const result = await stream(model, context, { apiKey: "test", timeoutMs: 5, fetch: () => response }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("response headers timed out");
		let cancelled!: () => void;
		const closed = new Promise<void>((resolve) => {
			cancelled = resolve;
		});
		deliver(
			new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancelled();
					},
				}),
			),
		);
		await closed;
	});
	it("cancels the response body when a response hook rejects it", async () => {
		let cancelled = false;
		const result = await stream(model, context, {
			apiKey: "test",
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							cancelled = true;
						},
					}),
				),
			onResponse: () => {
				throw new Error("consumer stopped");
			},
		}).result();
		expect(result.errorMessage).toBe("consumer stopped");
		expect(cancelled).toBe(true);
	});
	it.each([undefined, "none"] as const)(
		"uses sibling cache grouping with retention %s while keeping session affinity separate",
		async (cacheRetention) => {
			let payload: Record<string, unknown> | undefined;
			let headers: Headers | undefined;
			const result = await stream(model, context, {
				apiKey: "test",
				sessionId: "child-a",
				env: { OCTOCODE_PROMPT_CACHE_KEY: "siblings" },
				cacheRetention,
				fetch: async (_url, init) => {
					payload = JSON.parse(String(init?.body));
					headers = new Headers(init?.headers);
					return completed();
				},
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.usage).toMatchObject({ input: 4, cacheRead: 16 });
			expect(payload?.prompt_cache_key).toBe(cacheRetention === "none" ? undefined : "siblings");
			expect(headers?.get("x-affinity")).toBe(cacheRetention === "none" ? null : "child-a");
		},
	);
	it("honors retry configuration and retries a rejected request before streaming", async () => {
		let attempts = 0;
		const result = await stream(model, context, {
			apiKey: "test",
			maxRetries: 1,
			fetch: async () =>
				++attempts === 1 ? new Response("busy", { status: 503, headers: { "retry-after-ms": "1" } }) : completed(),
		}).result();
		expect(attempts).toBe(2);
		expect(result.stopReason).toBe("stop");
	});
	it("retains the provider retry delay after retries are exhausted", async () => {
		const result = await stream(model, context, {
			apiKey: "test",
			maxRetries: 0,
			fetch: async () => new Response("rate limited", { status: 429, headers: { "retry-after": "2" } }),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.retryAfterMs).toBe(2000);
	});
	it("does not retry a stream that has already emitted content", async () => {
		let attempts = 0;
		const result = await stream(model, context, {
			apiKey: "test",
			maxRetries: 2,
			fetch: async () => {
				attempts++;
				return new Response(
					'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\nevent: error\ndata: provider failed\n\n',
				);
			},
		}).result();
		expect(attempts).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("provider failed");
	});
});
