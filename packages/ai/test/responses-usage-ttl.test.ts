import { describe, expect, it } from "vitest";
import { parseResponsesUsage } from "../src/api/openai-responses-shared/response-result.ts";

describe("Responses usage write split", () => {
	it("records 30m writes beside 12h writes", () => {
		const usage = parseResponsesUsage({
			input_tokens: 12_000,
			output_tokens: 10,
			total_tokens: 12_010,
			input_tokens_details: {
				cached_tokens: 4000,
				cache_write_tokens: 7000,
				cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 },
			},
		});
		expect(usage).toMatchObject({
			input: 1000,
			cacheRead: 4000,
			cacheWrite: 7000,
			cacheWrite12h: 4000,
			cacheWrite30m: 3000,
		});
	});
	it("leaves the split unset when the provider reports none", () => {
		const usage = parseResponsesUsage({ input_tokens: 10, output_tokens: 1, total_tokens: 11 });
		expect(usage.cacheWrite30m).toBeUndefined();
		expect(usage.cacheWrite12h).toBeUndefined();
	});
});
