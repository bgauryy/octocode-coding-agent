import { afterEach, describe, expect, it, vi } from "vitest";
import { stream } from "../src/api/google-generative-ai.ts";
import { googleContext, googleFrames, googleModel } from "./google-fetch-fixture.ts";

const failure = (status: number) =>
	new Response(JSON.stringify({ error: { message: `got status: ${status}` } }), { status });
const success = () =>
	googleFrames([
		{ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] },
	]);

describe("google request retries", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries a headers-less SDK error with a retryable status", async () => {
		vi.useFakeTimers();
		const request = vi.fn<typeof fetch>().mockResolvedValueOnce(failure(429)).mockResolvedValueOnce(success());
		const result = stream(googleModel, googleContext, { apiKey: "test-key", fetch: request, maxRetries: 1 }).result();
		await vi.advanceTimersByTimeAsync(500);
		const output = await result;
		expect(output.stopReason).toBe("stop");
		expect(output.content).toMatchObject([{ type: "text", text: "ok" }]);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not retry when maxRetries is unset", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(failure(429));
		const output = await stream(googleModel, googleContext, { apiKey: "test-key", fetch: request }).result();
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("got status: 429");
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry a non-retryable status", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(failure(400));
		const output = await stream(googleModel, googleContext, {
			apiKey: "test-key",
			fetch: request,
			maxRetries: 2,
		}).result();
		expect(output.stopReason).toBe("error");
		expect(output.errorMessage).toContain("got status: 400");
		expect(request).toHaveBeenCalledTimes(1);
	});
});
