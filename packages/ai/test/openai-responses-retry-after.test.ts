import { describe, expect, it } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });

describe("OpenAI Responses retry-after", () => {
	it("copies the retry-after header of a 429 onto the error message", async () => {
		const message = await streamOpenAIResponses(getBuiltinModel("openai", "gpt-4o-mini"), context, {
			apiKey: "sk-test",
			fetch: async () => new Response("slow down", { status: 429, headers: { "retry-after": "12" } }),
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.retryAfterMs).toBe(12_000);
	});

	it("leaves retryAfterMs unset when the response has no retry hint", async () => {
		const message = await streamOpenAIResponses(getBuiltinModel("openai", "gpt-4o-mini"), context, {
			apiKey: "sk-test",
			fetch: async () => new Response("boom", { status: 500 }),
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.retryAfterMs).toBeUndefined();
	});
});
