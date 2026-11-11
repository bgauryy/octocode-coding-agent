import { describe, expect, it } from "vitest";
import { stream } from "../src/api/openai-codex-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-codex-responses"> = {
	id: "test",
	name: "test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://codex.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 100,
};
const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const token = `a.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test" } })).toString("base64")}.b`;

describe("Codex retry-after", () => {
	it("copies the retry-after header of a final 429 onto the error message", async () => {
		const message = await stream(model, context, {
			apiKey: token,
			transport: "sse",
			maxRetries: 0,
			fetch: async () => new Response("slow down", { status: 429, headers: { "retry-after": "12" } }),
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.retryAfterMs).toBe(12_000);
	});

	it("leaves retryAfterMs unset when the response has no retry hint", async () => {
		const message = await stream(model, context, {
			apiKey: token,
			transport: "sse",
			maxRetries: 0,
			fetch: async () => new Response("boom", { status: 500 }),
		}).result();

		expect(message.stopReason).toBe("error");
		expect(message.retryAfterMs).toBeUndefined();
	});
});
