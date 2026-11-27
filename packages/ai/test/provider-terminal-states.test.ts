import { describe, expect, it } from "vitest";
import { stream } from "../src/api/anthropic-messages.ts";
import { mapStopReason } from "../src/api/openai-responses-shared/response-result.ts";
import { resolveGoogleSimpleThinking } from "../src/api/ai-sdk/google-options.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";

async function streamAnthropic(startUsage: object, deltaUsage: object, stopReason = "end_turn") {
	const events = [
		{ type: "message_start", message: { id: "msg_t", usage: { output_tokens: 0, ...startUsage } } },
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage: deltaUsage },
		{ type: "message_stop" },
	];
	const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join("\n");
	const response = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	const fetch = async () => response;
	const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
	return stream(getBuiltinModel("anthropic", "claude-sonnet-4-5"), context, { apiKey: "test-key", fetch }).result();
}

describe("Anthropic pause_turn", () => {
	it("ends the turn as stop and keeps the raw reason", async () => {
		const result = await streamAnthropic({ input_tokens: 10 }, { output_tokens: 1 }, "pause_turn");
		expect(result.stopReason).toBe("stop");
		expect(result.rawStopReason).toBe("pause_turn");
	});
});

describe("Anthropic message_delta usage", () => {
	it("keeps message_start counts when a proxy reports zeros", async () => {
		const result = await streamAnthropic(
			{ input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 },
			{ input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 },
		);
		expect(result.usage.input).toBe(10);
		expect(result.usage.cacheRead).toBe(5);
		expect(result.usage.cacheWrite).toBe(7);
		expect(result.usage.output).toBe(3);
	});

	it("takes a larger cumulative count from message_delta", async () => {
		const result = await streamAnthropic({ input_tokens: 10 }, { input_tokens: 12, output_tokens: 3 });
		expect(result.usage.input).toBe(12);
	});
});

describe("OpenAI Responses terminal status", () => {
	it("treats a terminal event that still reports a running response as an error", () => {
		for (const status of ["in_progress", "queued"] as const) {
			const mapped = mapStopReason(status);
			expect(mapped.stopReason).toBe("error");
			expect(mapped.errorMessage).toContain(status);
		}
	});
});

describe("Google thinking level resolution", () => {
	it("clamps an unsupported level to a mapped one instead of throwing", () => {
		const model = {
			...getBuiltinModel("google", "gemini-2.5-flash"),
			thinkingLevelMap: { xhigh: null, max: null },
		} as Model<"google-generative-ai">;
		expect(() => resolveGoogleSimpleThinking(model, { reasoning: "xhigh" })).not.toThrow();
	});
});
