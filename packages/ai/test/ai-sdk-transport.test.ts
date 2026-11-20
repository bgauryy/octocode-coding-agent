import { describe, expect, it, vi } from "vitest";
import { fetchSdkResponse, prepareSdkRequest } from "../src/api/ai-sdk/transport.ts";
import { getBuiltinModel } from "../src/providers/all.ts";

const model = getBuiltinModel("google", "gemini-2.5-flash");
const url = "https://example.test/generate";

describe("SDK transport policy", () => {
	it("does not retry a failing response hook", async () => {
		const cancel = vi.fn();
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ cancel })));
		const onResponse = vi.fn(() => {
			throw new Error("hook failed");
		});
		await expect(fetchSdkResponse(model, { fetch, maxRetries: 1, onResponse }, url)).rejects.toThrow("hook failed");
		expect(fetch).toHaveBeenCalledOnce();
		expect(onResponse).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("does not retry a response hook error carrying HTTP 503 metadata", async () => {
		const cancel = vi.fn();
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ cancel })));
		const error = Object.assign(new Error("consumer stopped"), { status: 503, headers: new Headers() });
		const onResponse = vi.fn(() => {
			throw error;
		});
		await expect(fetchSdkResponse(model, { fetch, maxRetries: 2, onResponse }, url)).rejects.toBe(error);
		expect(fetch).toHaveBeenCalledOnce();
		expect(onResponse).toHaveBeenCalledOnce();
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("augments SDK JSON before the caller inspects it", async () => {
		const hook = vi.fn();
		const request = await prepareSdkRequest(model, { onPayload: hook }, url, { body: "{}" }, (body) => {
			body.extra = 1;
		});
		expect(hook).toHaveBeenCalledWith({ extra: 1 }, model);
		expect(JSON.parse(request!.body as string)).toEqual({ extra: 1 });
	});

	it("does not retry HTTP errors by default", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("busy", { status: 503 }));
		await expect(fetchSdkResponse(model, { fetch }, url)).rejects.toThrow("503 busy");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("honours configured retries and Retry-After before any stream starts", async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after-ms": "1" } }))
			.mockResolvedValueOnce(new Response("done"));
		const onPayload = vi.fn();
		const response = await fetchSdkResponse(model, { fetch, maxRetries: 1, onPayload }, url, { body: "{}" });
		expect(onPayload).toHaveBeenCalledOnce();
		expect(await response.text()).toBe("done");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("rejects an excessive retry delay without another request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response("busy", { status: 429, headers: { "retry-after": "120" } }),
		);
		await expect(fetchSdkResponse(model, { fetch, maxRetries: 1, maxRetryDelayMs: 1 }, url)).rejects.toThrow();
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("enforces the connection deadline even if custom fetch ignores its signal", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
		await expect(fetchSdkResponse(model, { fetch, timeoutMs: 10 }, url)).rejects.toThrow("timed out");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("cancels a stalled response body at its idle bound", async () => {
		const cancel = vi.fn();
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream({ cancel })));
		const response = await fetchSdkResponse(model, { fetch, timeoutMs: 10_000, streamIdleTimeoutMs: 10 }, url);
		await expect(response.text()).rejects.toThrow("timed out");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("keeps a streaming body alive past the header deadline while data keeps arriving", async () => {
		const anthropic = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		let sent = 0;
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					new ReadableStream({
						async pull(controller) {
							await new Promise((resolve) => setTimeout(resolve, 10));
							if (sent++ < 8) controller.enqueue(new TextEncoder().encode("x"));
							else controller.close();
						},
					}),
				),
		);
		// 8 chunks 10ms apart outlast the 30ms header deadline; each chunk resets the 50ms idle bound.
		const response = await fetchSdkResponse(anthropic, { fetch, timeoutMs: 30, streamIdleTimeoutMs: 50 }, url);
		expect(await response.text()).toBe("xxxxxxxx");
	});

	it("keeps completion streams alive after their header deadline", async () => {
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					new ReadableStream({
						start(value) {
							controller = value;
						},
					}),
				),
		);
		const response = await fetchSdkResponse({ ...model, api: "openai-completions" }, { fetch, timeoutMs: 0 }, url);
		controller!.enqueue(new TextEncoder().encode("done"));
		controller!.close();
		expect(await response.text()).toBe("done");
	});
});
