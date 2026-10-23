import { describe, expect, it, vi } from "vitest";
import { stream as azure } from "../src/api/azure-openai-responses.ts";
import { stream as completions } from "../src/api/openai-completions.ts";
import type { Api, Model } from "../src/types.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

const baseModel = {
	id: "test-model",
	name: "Test",
	provider: "test",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 1000,
} satisfies Omit<Model<Api>, "api">;

// Use the real SDK with an injected HTTP transport so its body ownership is exercised.
describe("SDK response-hook cleanup", () => {
	it.each(["openai-completions", "azure-openai-responses"] as const)(
		"cancels the unread %s body when an async response hook rejects",
		async (api) => {
			const cancel = vi.fn();
			let signal: AbortSignal | null | undefined;
			const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
				signal = init?.signal;
				return new Response(new ReadableStream({ cancel }), {
					headers: { "content-type": "text/event-stream" },
				});
			});
			const options = {
				apiKey: "synthetic-test-key",
				fetch,
				maxRetries: 2,
				onResponse: async () => {
					throw new Error("response hook rejected");
				},
			};
			const context = normalizeContext({ messages: [] });
			const stream =
				api === "openai-completions"
					? completions({ ...baseModel, api }, context, options)
					: azure({ ...baseModel, api }, context, options);
			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("response hook rejected");
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(signal?.aborted).toBe(true);
		},
	);
});
