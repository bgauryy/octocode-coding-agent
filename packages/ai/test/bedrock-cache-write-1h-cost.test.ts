import { describe, expect, it } from "vitest";
import { stream } from "../src/api/bedrock-converse-stream.ts";
import { bedrockModel as model, bedrockContext as context, bedrockResponse } from "./bedrock-fixtures.ts";

describe("Bedrock 1h cache write cost", () => {
	it("prices the 1h cache details at 2x while preserving the total cache write", async () => {
		const result = await stream(model, context, {
			apiKey: "test",
			env: {},
			cacheRetention: "none",
			fetch: async () =>
				bedrockResponse([
					{ messageStart: { role: "assistant" } },
					{
						metadata: {
							usage: {
								inputTokens: 100,
								outputTokens: 5,
								totalTokens: 1_000_105,
								cacheWriteInputTokens: 1_000_000,
								cacheDetails: [
									{ ttl: "1h", inputTokens: 150_000 },
									{ ttl: "5m", inputTokens: 600_000 },
									{ ttl: "1h", inputTokens: 250_000 },
								],
							},
						},
					},
					{ messageStop: { stopReason: "end_turn" } },
				]),
		}).result();
		expect(result.usage.cacheWrite).toBe(1_000_000);
		expect(result.usage.cacheWrite1h).toBe(400_000);
		const expectedCacheWriteCost = (600_000 * model.cost.cacheWrite + 400_000 * model.cost.input * 2) / 1_000_000;
		expect(result.usage.cost.cacheWrite).toBeCloseTo(expectedCacheWriteCost, 10);
	});
});
