import { describe, expect, it } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "capable-model",
	name: "Capable model",
	provider: "openai",
	api: "openai-responses",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
	compat: { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true },
};
const context = normalizeContext({
	systemPrompt: "Stable agent instructions",
	messages: [{ role: "user", content: "A task", timestamp: 0 }],
});
const usage = {
	input_tokens: 12000,
	output_tokens: 10,
	total_tokens: 12010,
	input_tokens_details: {
		cached_tokens: 4000,
		cache_write_tokens: 7000,
		cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 },
	},
};

async function run(terminal: Record<string, unknown>) {
	const body = `data: ${JSON.stringify(terminal)}\n\n`;
	return stream(model, context, {
		apiKey: "sk-fake",
		fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
	}).result();
}

describe("Responses terminal status on the SDK path", () => {
	it("records a completed response's status as its raw stop reason, with the per-TTL write split priced", async () => {
		const result = await run({
			type: "response.completed",
			response: { id: "resp_done", status: "completed", output: [], usage },
		});
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(result.rawStopReason).toBe("completed");
		expect(result.usage).toMatchObject({
			input: 1000,
			output: 10,
			cacheRead: 4000,
			cacheWrite: 7000,
			cacheWrite12h: 4000,
			cacheWrite30m: 3000,
			totalTokens: 12010,
		});
		// 3000 30m tokens at the write rate (1.25) and 4000 12h tokens at 2.5x input.
		expect(result.usage.cost.cacheWrite).toBeCloseTo((3000 * 1.25 + 4000 * 2.5) / 1e6, 12);
		expect(result.usage.cost.total).toBeCloseTo((1000 * 1 + 10 * 2 + 4000 * 0.1 + 3000 * 1.25 + 4000 * 2.5) / 1e6, 12);
	});

	it("keeps an incomplete response's reason beside its status", async () => {
		const result = await run({
			type: "response.incomplete",
			response: {
				id: "resp_cut",
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				output: [],
				usage,
			},
		});
		expect(result.stopReason).toBe("length");
		expect(result.rawStopReason).toBe("incomplete.max_output_tokens");
	});
});
