import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { stream as completionsStream } from "../src/api/openai-completions.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model, StreamOptions } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

/**
 * OpenRouter reports one `cache_write_tokens` count with no split by lifetime, so the adapter prices a write at the 1h
 * rate only when every marker it sent was a 1h marker, as the Anthropic adapter does without `cache_creation`.
 * USD per MTok: input 3, so a 5m write is 3.75 (the listed rate) and a 1h write 2x input, 6.
 */
const model: Model<"openai-completions"> = {
	...getBuiltinModel("openrouter", "anthropic/claude-fable-5.1:batch"),
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};
const context = normalizeContext({
	systemPrompt: "Stable agent instructions",
	messages: [{ role: "user", content: "A changing task", timestamp: 0 }],
	tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
});
const WRITTEN = 100_000;

function sse(events: unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

async function run(options: StreamOptions, target: Model<"openai-completions"> = model) {
	const markers: unknown[] = [];
	const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
		JSON.stringify(JSON.parse(String(init?.body)), (key, value) => {
			if (key === "cache_control") markers.push(value);
			return value;
		});
		return sse([
			{
				choices: [
					{
						delta: { content: "ok" },
						finish_reason: "stop",
						usage: {
							prompt_tokens: WRITTEN + 10,
							completion_tokens: 1,
							prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: WRITTEN },
						},
					},
				],
			},
		]);
	});
	const result = await completionsStream(target, context, { apiKey: "test-key", fetch, ...options }).result();
	expect(result.errorMessage).toBeUndefined();
	return { usage: result.usage, markers };
}

describe("OpenRouter Anthropic-format cache-write pricing", () => {
	it("prices the write at the 1h rate when every marker sent was 1h", async () => {
		const { usage, markers } = await run({ cacheRetention: "long", instructionCacheRetention: "long" });
		expect(markers.length).toBeGreaterThan(0);
		expect(markers.every((marker) => (marker as { ttl?: string }).ttl === "1h")).toBe(true);
		expect(usage.cacheWrite).toBe(WRITTEN);
		expect(usage.cacheWrite1h).toBe(WRITTEN);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.6, 9);
	});

	it("keeps the 5m rate when any marker sent was 5m (long instructions over short history)", async () => {
		const { usage, markers } = await run({ cacheRetention: "short", instructionCacheRetention: "long" });
		expect(markers.some((marker) => (marker as { ttl?: string }).ttl === undefined)).toBe(true);
		expect(usage.cacheWrite1h ?? 0).toBe(0);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.375, 9);
	});

	it("keeps the 5m rate when the endpoint has no long tier, so long retention sends 5m markers", async () => {
		const gateway: Model<"openai-completions"> = {
			...model,
			compat: { ...model.compat, supportsLongCacheRetention: false },
		};
		const { usage } = await run({ cacheRetention: "long", instructionCacheRetention: "long" }, gateway);
		expect(usage.cacheWrite1h ?? 0).toBe(0);
		expect(usage.cost.cacheWrite).toBeCloseTo(0.375, 9);
	});
});
