import { stream } from "../src/api/google-generative-ai.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { describe, expect, it } from "vitest";
async function mapStopReason(finishReason: string) {
	const model: Model<"google-generative-ai"> = {
		id: "gemini-2.5-flash",
		name: "Gemini",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
	const frame = { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "answer" }] }, finishReason }] };
	const result = await stream(model, normalizeContext({ messages: [{ role: "user", content: "Hi", timestamp: 0 }] }), {
		apiKey: "test-key",
		fetch: async () =>
			new Response(`data: ${JSON.stringify(frame)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
	}).result();
	return result.stopReason;
}

describe("Gemini finish reason mapping", () => {
	it("maps CONTINUATION, a stop at the per-request token limit, to length", async () => {
		expect(await mapStopReason("CONTINUATION")).toBe("length");
	});

	it("keeps MAX_TOKENS as length and STOP as stop", async () => {
		expect(await mapStopReason("MAX_TOKENS")).toBe("length");
		expect(await mapStopReason("STOP")).toBe("stop");
	});

	it.each(["MISSING_THOUGHT_SIGNATURE", "MALFORMED_RESPONSE", "SOME_FUTURE_REASON"])(
		"maps %s, a reason the SDK enum does not know, to error instead of throwing",
		async (reason) => {
			expect(await mapStopReason(reason)).toBe("error");
		},
	);
});
