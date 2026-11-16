import { describe, expect, it } from "vitest";
import { anthropicSdkInput } from "../src/api/ai-sdk/anthropic-input.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { normalizeContext } from "../src/utils/transcript.ts";
import { streamAnthropic } from "./anthropic-stop-reason-fixtures.ts";

// Sonnet 4.5: input $3/Mtok, 5m write $3.75, 1h write 2x input = $6.
const write = { cache_creation_input_tokens: 20_000 };

describe("1h cache write pricing when the vendor omits the TTL breakdown", () => {
	it("prices aggregate writes at the 1h rate when the request asked for 1h", async () => {
		const result = await streamAnthropic("end_turn", { startUsage: write, longRetention: true });
		expect(result.usage.cacheWrite1h).toBe(20_000);
		expect(result.usage.cost.cacheWrite).toBeCloseTo(0.12, 10);
	});

	it("keeps the 5m rate when 1h was not requested", async () => {
		const result = await streamAnthropic("end_turn", { startUsage: write });
		expect(result.usage.cacheWrite1h).toBe(0);
		expect(result.usage.cost.cacheWrite).toBeCloseTo(0.075, 10);
	});

	it("assumes 1h only when every breakpoint asks for 1h", async () => {
		const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
		const context = normalizeContext({ systemPrompt: "x", messages: [{ role: "user", content: "hi", timestamp: 0 }] });
		const { anthropicSdkCache } = await import("../src/api/ai-sdk/anthropic-cache.ts");
		const long = (cacheRetention?: "long" | "short" | "none", instructionCacheRetention?: "long" | "none") => {
			const options = { cacheRetention, instructionCacheRetention, env: {} };
			const mapping = anthropicSdkInput(model, context, options);
			return anthropicSdkCache(model, context, options, mapping.messages!, mapping.tools!);
		};
		expect(long("long", "long")).toBe(true);
		expect(long("short", "long")).toBe(false);
		expect(long(undefined, "long")).toBe(false);
		expect(long("none", "none")).toBe(false);
	});

	it("prices later writes at the 1h rate when an earlier breakdown no longer covers them", async () => {
		// Proxies that report usage at the end can send a zeroed breakdown on message_start.
		const result = await streamAnthropic("end_turn", {
			startUsage: {
				cache_creation_input_tokens: 0,
				cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
			},
			deltaUsage: write,
			longRetention: true,
		});
		expect(result.usage.cacheWrite).toBe(20_000);
		expect(result.usage.cacheWrite1h).toBe(20_000);
		expect(result.usage.cost.cacheWrite).toBeCloseTo(0.12, 10);
	});

	it("keeps a breakdown when message_delta repeats the same aggregate", async () => {
		const result = await streamAnthropic("end_turn", {
			startUsage: {
				...write,
				cache_creation: { ephemeral_5m_input_tokens: 20_000, ephemeral_1h_input_tokens: 0 },
			},
			deltaUsage: write,
			longRetention: true,
		});
		expect(result.usage.cacheWrite1h).toBe(0);
		expect(result.usage.cost.cacheWrite).toBeCloseTo(0.075, 10);
	});

	it("trusts a reported breakdown over the request", async () => {
		const result = await streamAnthropic("end_turn", {
			startUsage: {
				...write,
				cache_creation: { ephemeral_5m_input_tokens: 20_000, ephemeral_1h_input_tokens: 0 },
			},
			longRetention: true,
		});
		expect(result.usage.cacheWrite1h).toBe(0);
		expect(result.usage.cost.cacheWrite).toBeCloseTo(0.075, 10);
	});
});
