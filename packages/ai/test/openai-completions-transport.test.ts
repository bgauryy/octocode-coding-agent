import { afterEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";
import { stream } from "../src/api/openai-completions.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";
import { requestJsonEventStream } from "../src/utils/json-event-stream.ts";

const model = { ...getBuiltinModel("openai", "gpt-4o-mini"), api: "openai-completions" } as Model<"openai-completions">;
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });

describe("Vercel completion transport", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});
	it("keeps OpenAI SDK tenant environment defaults on compatible endpoints", async () => {
		vi.stubEnv("OPENAI_ORG_ID", "org-environment");
		vi.stubEnv("OPENAI_PROJECT_ID", "project-environment");
		vi.stubEnv("OPENAI_CUSTOM_HEADERS", "x-environment: fixture");
		const sent: Headers[] = [];
		const fetch: typeof globalThis.fetch = async (_url, init) => {
			sent.push(new Headers(init?.headers));
			return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
		};
		const baseUrl = "https://compatible.example/v1";
		const previous = new OpenAI({ apiKey: "test", baseURL: baseUrl, fetch, maxRetries: 0 });
		const events = await previous.chat.completions.create({ model: model.id, messages: [], stream: true });
		for await (const _event of events) {
			/* Drain the official SDK's response. */
		}
		const result = await stream({ ...model, provider: "custom", baseUrl }, context, { apiKey: "test", fetch }).result();
		expect(result.stopReason).toBe("stop");
		for (const name of ["openai-organization", "openai-project", "x-environment"]) {
			expect(sent[1].get(name)).toBe(sent[0].get(name));
			expect(sent[1].has(name)).toBe(true);
		}
	});
	it.each([false, true])("applies scoped environment, model and request header precedence (%s)", async (override) => {
		vi.stubEnv("OPENAI_ORG_ID", "ambient-org");
		vi.stubEnv("OPENAI_PROJECT_ID", "ambient-project");
		let headers = new Headers();
		const result = await stream({ ...model, headers: { "OpenAI-Organization": "model-org" } }, context, {
			apiKey: "test",
			env: { OPENAI_ORG_ID: "scoped-org", OPENAI_PROJECT_ID: "scoped-project" },
			headers: override ? { "openai-organization": "request-org", "OPENAI-PROJECT": null } : undefined,
			fetch: async (_url, init) => {
				headers = new Headers(init?.headers);
				return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(headers.get("openai-organization")).toBe(override ? "request-org" : "model-org");
		expect(headers.get("openai-project")).toBe(override ? null : "scoped-project");
	});
	it("allows a successful completion stream to outlive its response-header timeout", async () => {
		vi.useFakeTimers();
		let finish!: ReadableStreamDefaultController<Uint8Array>;
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const result = stream(model, context, {
			apiKey: "test",
			timeoutMs: 20,
			onResponse: ready,
			fetch: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							finish = controller;
						},
					}),
				),
		}).result();
		await started;
		await vi.advanceTimersByTimeAsync(60);
		finish.enqueue(
			new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n'),
		);
		finish.close();
		expect((await result).stopReason).toBe("stop");
	});
	it("retains the whole-stream deadline for Responses", async () => {
		vi.useFakeTimers();
		let cancelled = false;
		const request = await requestJsonEventStream(
			new URL("https://provider.example/responses"),
			{},
			{},
			{
				timeoutMs: 20,
				fetch: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							cancel() {
								cancelled = true;
							},
						}),
					),
			},
		);
		try {
			const read = request.events.next();
			const failure = expect(read).rejects.toThrow("timed out");
			await vi.advanceTimersByTimeAsync(60);
			await failure;
			expect(cancelled).toBe(true);
		} finally {
			request.dispose();
		}
	});
	it("cancels a stalled HTTP error body at the request deadline", async () => {
		let cancelled!: () => void;
		const closed = new Promise<void>((resolve) => {
			cancelled = resolve;
		});
		const result = await stream(model, context, {
			apiKey: "test",
			timeoutMs: 5,
			fetch: async () => new Response(new ReadableStream({ cancel: cancelled }), { status: 503 }),
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
		await closed;
	});
	it("times out ignored fetch signals and cancels a late response", async () => {
		let deliver!: (response: Response) => void;
		const pending = new Promise<Response>((resolve) => {
			deliver = resolve;
		});
		const result = await stream(model, context, { apiKey: "test", timeoutMs: 5, fetch: () => pending }).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timed out");
		let cancelled!: () => void;
		const closed = new Promise<void>((resolve) => {
			cancelled = resolve;
		});
		deliver(new Response(new ReadableStream({ cancel: cancelled })));
		await closed;
	});

	it("releases a rejected response hook without retrying it", async () => {
		let cancelled = false;
		let requests = 0;
		const result = await stream(model, context, {
			apiKey: "test",
			maxRetries: 2,
			fetch: async () => {
				requests++;
				return new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				);
			},
			onResponse: () => {
				throw Object.assign(new Error("consumer stopped"), { status: 503, headers: new Headers() });
			},
		}).result();
		expect(result.errorMessage).toBe("consumer stopped");
		expect(cancelled).toBe(true);
		expect(requests).toBe(1);
	});

	it("cancels a stalled body after caller abort", async () => {
		const controller = new AbortController();
		let ready!: () => void;
		let cancelled = false;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const result = stream(model, context, {
			apiKey: "test",
			signal: controller.signal,
			fetch: async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled = true;
						},
					}),
				),
			onResponse: ready,
		}).result();
		await started;
		controller.abort();
		expect((await result).stopReason).toBe("aborted");
		expect(cancelled).toBe(true);
	});

	it("never retries a provider failure after content starts", async () => {
		let requests = 0;
		const result = await stream(model, context, {
			apiKey: "test",
			maxRetries: 2,
			fetch: async () => {
				requests++;
				return new Response(
					'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\nevent: error\ndata: provider failed\n\n',
				);
			},
		}).result();
		expect(requests).toBe(1);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("provider failed");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "partial" }));
	});

	it("retains base URL queries and removes overridden authorization headers", async () => {
		let requestedUrl = "";
		let headers = new Headers();
		const result = await stream({ ...model, baseUrl: "https://gateway.example/v1?route=private" }, context, {
			apiKey: "test",
			headers: { Authorization: null, "x-gateway-key": "gateway-token" },
			fetch: async (url, init) => {
				requestedUrl = String(url);
				headers = new Headers(init?.headers);
				return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
			},
		}).result();
		expect(result.stopReason).toBe("stop");
		expect(requestedUrl).toBe("https://gateway.example/v1/chat/completions?route=private");
		expect(headers.has("authorization")).toBe(false);
		expect(headers.get("x-gateway-key")).toBe("gateway-token");
	});
});
