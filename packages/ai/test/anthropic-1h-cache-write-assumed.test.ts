import { describe, expect, it } from "vitest";
import { requestsLongCache } from "../src/api/anthropic-messages/stream-events.ts";
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

	it("assumes 1h only when every breakpoint asks for 1h", () => {
		const block = (ttl?: string) => ({
			type: "text",
			text: "x",
			cache_control: { type: "ephemeral", ...(ttl ? { ttl } : {}) },
		});
		expect(requestsLongCache({ system: [block("1h")], messages: [{ content: [block("1h")] }] })).toBe(true);
		// Long instructions with a short history: the split is unknown.
		expect(requestsLongCache({ system: [block("1h")], messages: [{ content: [block("5m")] }] })).toBe(false);
		expect(requestsLongCache({ system: [block("1h")], messages: [{ content: [block()] }] })).toBe(false);
		expect(requestsLongCache({ system: [{ type: "text", text: "x" }] })).toBe(false);
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
