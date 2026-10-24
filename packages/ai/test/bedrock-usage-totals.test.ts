import { describe, expect, it } from "vitest";
import { handleMetadata } from "../src/api/bedrock-converse-stream/stream-events.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { createPendingAssistantMessage } from "../src/utils/assistant-message.ts";

const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

describe("Bedrock usage totals", () => {
	it("counts cache reads and writes in the total when Bedrock omits totalTokens", () => {
		const output = createPendingAssistantMessage(model, "bedrock-converse-stream");
		handleMetadata(
			{
				usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 300, cacheWriteInputTokens: 200 },
				metrics: undefined,
			} as never,
			model,
			output,
		);
		expect(output.usage).toMatchObject({ input: 10, output: 5, cacheRead: 300, cacheWrite: 200, totalTokens: 515 });
		// No TTL breakdown means no one-hour writes; the aggregate is priced at the five-minute rate.
		expect(output.usage.cacheWrite1h ?? 0).toBe(0);
	});

	it("keeps Bedrock's own total when it is reported", () => {
		const output = createPendingAssistantMessage(model, "bedrock-converse-stream");
		handleMetadata(
			{ usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 300, totalTokens: 315 } } as never,
			model,
			output,
		);
		expect(output.usage.totalTokens).toBe(315);
	});
});
