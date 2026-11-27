import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSdkResponse } from "../src/api/ai-sdk/transport.ts";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, resolveStreamIdleTimeoutMs } from "../src/api/ai-sdk/stream-idle.ts";
import { isRetryableErrorText } from "../src/utils/retry-classes.ts";
import { getBuiltinModel } from "../src/providers/all.ts";

const model = getBuiltinModel("google", "gemini-2.5-flash");
const url = "https://example.test/generate";
const encoder = new TextEncoder();

afterEach(() => vi.useRealTimers());

function stalledFetch(cancel = vi.fn()) {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const fetch = vi.fn<typeof globalThis.fetch>(async () => {
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
			cancel,
		});
		return new Response(body);
	});
	return { fetch, push: (text: string) => controller.enqueue(encoder.encode(text)), cancel };
}

describe("stream idle timeout", () => {
	it("aborts a silent stream with a retryable error and cancels the body", async () => {
		vi.useFakeTimers();
		const stalled = stalledFetch();
		const response = await fetchSdkResponse(model, { fetch: stalled.fetch, streamIdleTimeoutMs: 1000 }, url);
		const reader = response.body!.getReader();
		stalled.push("data: {}\n\n");
		expect((await reader.read()).done).toBe(false);
		const next = reader.read();
		const assertion = expect(next).rejects.toSatisfy((error: Error) => isRetryableErrorText(error.message));
		await vi.advanceTimersByTimeAsync(1000);
		await assertion;
		expect(stalled.cancel).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("treats any chunk, including a keep-alive comment, as activity", async () => {
		vi.useFakeTimers();
		const stalled = stalledFetch();
		const response = await fetchSdkResponse(model, { fetch: stalled.fetch, streamIdleTimeoutMs: 1000 }, url);
		const reader = response.body!.getReader();
		for (let i = 0; i < 5; i++) {
			const read = reader.read();
			await vi.advanceTimersByTimeAsync(900);
			stalled.push(": keep-alive\n\n");
			expect((await read).done).toBe(false);
		}
		await reader.cancel();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("can be disabled with 0 and defaults to five minutes", () => {
		expect(resolveStreamIdleTimeoutMs(0)).toBeUndefined();
		expect(resolveStreamIdleTimeoutMs(undefined)).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
		expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBe(300_000);
		expect(() => resolveStreamIdleTimeoutMs(-1)).toThrow("Invalid streamIdleTimeoutMs");
	});
});
