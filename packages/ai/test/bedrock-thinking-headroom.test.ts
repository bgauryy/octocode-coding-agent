import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/bedrock-converse-stream.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"bedrock-converse-stream"> = {
	id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
	name: "Claude 3.7 Sonnet",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 64000,
};

describe("Bedrock budget thinking near the context limit", () => {
	it.each([904, 1536, 2048])("keeps the request valid with %s tokens of headroom", async (headroom) => {
		const promptTokens = model.contextWindow - 4096 - headroom;
		const context = normalizeContext({
			messages: [
				{
					role: "user",
					content: "x".repeat(promptTokens * 3.5),
					timestamp: 0,
				},
			],
		});
		let payload:
			| {
					inferenceConfig: { maxTokens: number };
					additionalModelRequestFields?: {
						thinking?: { budget_tokens: number };
					};
			  }
			| undefined;
		const result = await streamSimple(model, context, {
			reasoning: "high",
			env: { AWS_BEDROCK_SKIP_AUTH: "1" },
			onPayload(value) {
				payload = value as typeof payload;
				throw new Error("payload captured");
			},
		}).result();
		expect(result.errorMessage).toContain("payload captured");
		expect(payload?.inferenceConfig.maxTokens).toBe(headroom);
		if (headroom < 2048) expect(payload?.additionalModelRequestFields).toBeUndefined();
		else expect(payload?.additionalModelRequestFields?.thinking?.budget_tokens).toBe(1024);
	});
});
