import { describe, expect, it, vi } from "vitest";
import { generateImages } from "../src/api/openrouter-images.ts";
import type { ImageModel } from "../src/types.ts";

const model: ImageModel<"openrouter-images"> = {
	type: "image",
	id: "fixture",
	name: "Fixture",
	api: "openrouter-images",
	provider: "openrouter",
	baseUrl: "https://images.test/v1?route=private",
	input: ["text"],
	output: ["image"],
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
};
const context = { input: [{ type: "text" as const, text: "Draw" }] };
it("retries HTTP failures with hooks once and preserves queries and cache usage", async () => {
	let attempts = 0;
	const onPayload = vi.fn(() => undefined);
	const onResponse = vi.fn();
	const result = await generateImages(model, context, {
		apiKey: "fixture",
		maxRetries: 1,
		onPayload,
		onResponse,
		fetch: async (url) => {
			expect(String(url)).toBe("https://images.test/v1/chat/completions?route=private");
			if (++attempts === 1)
				return Response.json({ error: "retry" }, { status: 503, headers: { "retry-after-ms": "1" } });
			return Response.json({
				id: "image",
				choices: [],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 4,
					prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
				},
			});
		},
	});
	expect(result.stopReason).toBe("stop");
	expect(attempts).toBe(2);
	expect(onPayload).toHaveBeenCalledTimes(1);
	expect(onResponse).toHaveBeenCalledTimes(1);
	expect(result.usage).toMatchObject({ input: 5, output: 4, cacheRead: 2, cacheWrite: 3 });
	expect(result.usage?.cost.total).toBeGreaterThan(0);
});
describe.each([200, 503])("image stalled body status %i", (status) => {
	it("cancels the body on deadline", async () => {
		let cancelled!: () => void;
		const closed = new Promise<void>((resolve) => {
			cancelled = resolve;
		});
		const result = await generateImages(model, context, {
			apiKey: "fixture",
			maxRetries: 0,
			timeoutMs: 5,
			fetch: async () => new Response(new ReadableStream({ cancel: cancelled }), { status }),
		});
		expect(result.stopReason).toBe("error");
		await closed;
	});
});
it("cancels a late response when custom fetch ignores abort", async () => {
	let deliver!: (response: Response) => void;
	const response = new Promise<Response>((resolve) => {
		deliver = resolve;
	});
	const result = await generateImages(model, context, {
		apiKey: "fixture",
		maxRetries: 0,
		timeoutMs: 5,
		fetch: () => response,
	});
	expect(result.stopReason).toBe("error");
	let cancelled!: () => void;
	const closed = new Promise<void>((resolve) => {
		cancelled = resolve;
	});
	deliver(new Response(new ReadableStream({ cancel: cancelled })));
	await closed;
});
