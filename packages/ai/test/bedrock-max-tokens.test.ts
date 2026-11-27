import { describe, expect, it } from "vitest";
import { stream } from "../src/api/bedrock-converse-stream.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { bedrockContext, bedrockResponse } from "./bedrock-fixtures.ts";

describe("Bedrock adaptive Claude max tokens", () => {
	it("sends the model token cap and preserves usage above the service default", async () => {
		const model = { ...getBuiltinModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6"), maxTokens: 6000 };
		let maxTokens: unknown;
		const response = await stream(model, bedrockContext, {
			apiKey: "test",
			env: {},
			reasoning: "low",
			fetch: async (_input, init) => {
				maxTokens = JSON.parse(String(init?.body)).inferenceConfig.maxTokens;
				return bedrockResponse([
					{ messageStart: { role: "assistant" } },
					{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "alpha" } } },
					{ contentBlockStop: { contentBlockIndex: 0 } },
					{ messageStop: { stopReason: "end_turn" } },
					{ metadata: { usage: { inputTokens: 10, outputTokens: 5200, totalTokens: 5210 } } },
				]);
			},
		}).result();
		expect(maxTokens).toBe(6000);
		expect(response.stopReason, response.errorMessage).not.toBe("error");
		expect(response.usage.output).toBeGreaterThan(4096);
	});
});
