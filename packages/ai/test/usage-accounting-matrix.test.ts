import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { parseChunkUsage } from "../src/api/openai-completions/usage.ts";
import { applyServiceTierPricing } from "../src/api/openai-responses/request.ts";
import { parseResponsesUsage } from "../src/api/openai-responses-shared/response-result.ts";
import { googleUsage as normalizeGoogleUsage } from "./google-fetch-fixture.ts";
import { normalizeContext } from "../src/compat.ts";
import { calculateCost } from "../src/models.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model, Usage } from "../src/types.ts";

/**
 * Provider usage as each adapter's real parser reads it, then priced from the model data, against hand-computed
 * numbers. The invariant every row pins: `input + cacheRead + cacheWrite` is the provider's whole prompt, so the cache share
 * `cacheRead / (input + cacheRead + cacheWrite)` has nothing counted twice. Prices are the model data's USD per million
 * tokens, written beside each expectation.
 */
const promptOf = (usage: Usage) => usage.input + usage.cacheRead + usage.cacheWrite;
const share = (usage: Usage) => usage.cacheRead / promptOf(usage);

const sse = (events: Array<[string, unknown]>): Response =>
	new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n`).join("\n"), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
const responseOptions = (response: Response) => ({ apiKey: "test-key", fetch: async () => response });

describe("Anthropic usage", () => {
	// claude-opus-4-8: input 5, output 25, cacheRead 0.5, cacheWrite (5m) 6.25; a 1h write is 2x input = 10.
	it("reads input excluding cache, splits writes by TTL, and prices every class", async () => {
		const model = getBuiltinModel("anthropic", "claude-opus-4-8");
		const response = sse([
			[
				"message_start",
				{
					type: "message_start",
					message: {
						id: "m1",
						usage: {
							input_tokens: 100,
							output_tokens: 1,
							cache_read_input_tokens: 200_000,
							cache_creation_input_tokens: 50_000,
							cache_creation: { ephemeral_5m_input_tokens: 30_000, ephemeral_1h_input_tokens: 20_000 },
						},
					},
				},
			],
			["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
			["content_block_stop", { type: "content_block_stop", index: 0 }],
			[
				"message_delta",
				{
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 1000, output_tokens_details: { thinking_tokens: 400 } },
				},
			],
			["message_stop", { type: "message_stop" }],
		]);
		const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
		const { usage } = await streamAnthropic(model, context, responseOptions(response)).result();

		expect(usage).toMatchObject({
			input: 100,
			output: 1000,
			cacheRead: 200_000,
			cacheWrite: 50_000,
			cacheWrite1h: 20_000,
			reasoning: 400,
			// input + output + cacheRead + cacheWrite; reasoning is part of output.
			totalTokens: 251_100,
		});
		expect(promptOf(usage)).toBe(250_100);
		expect(share(usage)).toBeCloseTo(200_000 / 250_100, 12);
		// 100 * 5 = 500; 1000 * 25 = 25000; 200000 * 0.5 = 100000; 30000 * 6.25 + 20000 * 10 = 387500 (micro-dollars).
		expect(usage.cost.input).toBeCloseTo(0.0005, 12);
		expect(usage.cost.output).toBeCloseTo(0.025, 12);
		expect(usage.cost.cacheRead).toBeCloseTo(0.1, 12);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.3875, 12);
		expect(usage.cost.total).toBeCloseTo(0.513, 12);
	});
});

describe("OpenAI Chat Completions usage (cached tokens are inside prompt_tokens)", () => {
	// gpt-5.4: input 2.5, output 15, cacheRead 0.25; above 272000 prompt tokens: input 5, output 22.5, cacheRead 0.5.
	const model = getBuiltinModel("openai", "gpt-5.4") as unknown as Model<"openai-completions">;

	it("subtracts cached tokens from the prompt and prices the whole request at the long-context tier", () => {
		const usage = parseChunkUsage(
			{
				prompt_tokens: 300_000,
				completion_tokens: 1000,
				prompt_tokens_details: { cached_tokens: 200_000 },
				completion_tokens_details: { reasoning_tokens: 300 },
			},
			model,
		);
		expect(usage).toMatchObject({ input: 100_000, output: 1000, cacheRead: 200_000, cacheWrite: 0, reasoning: 300 });
		expect(promptOf(usage)).toBe(300_000);
		expect(share(usage)).toBeCloseTo(2 / 3, 12);
		// Tier: 100000 * 5 = 0.5; 1000 * 22.5 = 0.0225; 200000 * 0.5 = 0.1.
		expect(usage.cost.total).toBeCloseTo(0.6225, 12);
	});

	it("reads the Anthropic-style top-level cache fields an Anthropic-format gateway reports", () => {
		const usage = parseChunkUsage(
			{ prompt_tokens: 100, completion_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 },
			model,
		);
		expect(usage).toMatchObject({ input: 10, cacheRead: 80, cacheWrite: 10 });
	});

	it("switches tier strictly above the threshold, counting cache reads and writes in the prompt", () => {
		const at = parseChunkUsage({ prompt_tokens: 272_000, completion_tokens: 0 }, model);
		const above = parseChunkUsage({ prompt_tokens: 272_001, completion_tokens: 0 }, model);
		expect(at.cost.total).toBeCloseTo(0.68, 12); // 272000 * 2.5
		expect(above.cost.total).toBeCloseTo(1.360005, 12); // 272001 * 5
		// 272001 prompt tokens that are mostly cached still select the tier: cacheRead 0.5, input 5.
		const cached = parseChunkUsage(
			{ prompt_tokens: 272_001, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 272_000 } },
			model,
		);
		expect(cached.cost.total).toBeCloseTo(272_000 * 0.5e-6 + 5e-6, 12);
	});

	it.each([
		["OpenAI/OpenRouter", { prompt_tokens_details: { cached_tokens: 400 } }],
		["DeepSeek", { prompt_cache_hit_tokens: 400 }],
		["Kimi", { cached_tokens: 400 }],
	])("reads %s's cached-token field as cache reads inside the prompt", (_name, fields) => {
		const usage = parseChunkUsage({ prompt_tokens: 1000, completion_tokens: 10, ...fields }, model);
		expect(usage).toMatchObject({ input: 600, cacheRead: 400, cacheWrite: 0 });
		expect(share(usage)).toBeCloseTo(0.4, 12);
	});

	it("keeps OpenRouter cache writes separate from reads and inside the prompt", () => {
		const usage = parseChunkUsage(
			{
				prompt_tokens: 1000,
				completion_tokens: 10,
				prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
			},
			model,
		);
		expect(usage).toMatchObject({ input: 500, cacheRead: 400, cacheWrite: 100 });
		expect(promptOf(usage)).toBe(1000);
	});
});

describe("OpenAI Responses usage", () => {
	// gpt-5.6-sol: input 4, output 20, cacheRead 0.4, cacheWrite 5 (below 272000 prompt tokens).
	const model = getBuiltinModel("openai", "gpt-5.6-sol");
	const raw = {
		input_tokens: 1000,
		input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
		output_tokens: 50,
		output_tokens_details: { reasoning_tokens: 20 },
		total_tokens: 1050,
	} as never;

	it("subtracts cached and written tokens from input_tokens and keeps the provider total", () => {
		const usage = parseResponsesUsage(raw);
		expect(usage).toMatchObject({
			input: 300,
			cacheRead: 600,
			cacheWrite: 100,
			output: 50,
			reasoning: 20,
			totalTokens: 1050,
		});
		expect(promptOf(usage)).toBe(1000);
		expect(share(usage)).toBeCloseTo(0.6, 12);
	});

	it("prices each class, then scales every class by the service tier", () => {
		const usage = parseResponsesUsage(raw);
		calculateCost(model, usage);
		// 300 * 4 + 600 * 0.4 + 100 * 5 + 50 * 20 = 1200 + 240 + 500 + 1000 = 2940 micro-dollars.
		expect(usage.cost.input).toBeCloseTo(0.0012, 12);
		expect(usage.cost.cacheRead).toBeCloseTo(0.00024, 12);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.0005, 12);
		expect(usage.cost.output).toBeCloseTo(0.001, 12);
		expect(usage.cost.total).toBeCloseTo(0.00294, 12);
		applyServiceTierPricing(usage, "priority", model);
		expect(usage.cost.total).toBeCloseTo(0.00588, 12);
		expect(usage.cost.cacheRead).toBeCloseTo(0.00048, 12);
	});
});

describe("Google usage (cachedContentTokenCount is inside promptTokenCount, thoughts bill as output)", () => {
	// gemini-2.5-pro: input 1.25, output 10, cacheRead 0.125; above 200000 prompt tokens: 2.5, 15, 0.25.
	it("splits the cache out of the prompt, folds thoughts into output and prices the long-context tier", async () => {
		const model = getBuiltinModel("google", "gemini-2.5-pro");
		const usage = await normalizeGoogleUsage({
			promptTokenCount: 250_000,
			cachedContentTokenCount: 200_000,
			candidatesTokenCount: 1000,
			thoughtsTokenCount: 500,
			totalTokenCount: 251_500,
		});
		expect(usage).toMatchObject({
			input: 50_000,
			cacheRead: 200_000,
			output: 1500,
			reasoning: 500,
			totalTokens: 251_500,
		});
		expect(promptOf(usage)).toBe(250_000);
		calculateCost(model, usage);
		// 50000 * 2.5 = 0.125; 200000 * 0.25 = 0.05; 1500 * 15 = 0.0225.
		expect(usage.cost.total).toBeCloseTo(0.1975, 12);
	});
});
