import { describe, expect, it } from "vitest";
import { stream } from "../src/api/bedrock-converse-stream.ts";
import { bedrockModel, bedrockContext, bedrockResponse } from "./bedrock-fixtures.ts";

async function usage(usage: Record<string, number>) {
	return stream(bedrockModel, bedrockContext, {
		apiKey: "test",
		env: {},
		fetch: async () =>
			bedrockResponse([
				{ messageStart: { role: "assistant" } },
				{ metadata: { usage } },
				{ messageStop: { stopReason: "end_turn" } },
			]),
	}).result();
}

describe("Bedrock usage totals", () => {
	it("counts cache reads and writes in the total when Bedrock omits totalTokens", async () => {
		const output = await usage({
			inputTokens: 10,
			outputTokens: 5,
			cacheReadInputTokens: 300,
			cacheWriteInputTokens: 200,
		});
		expect(output.usage).toMatchObject({ input: 10, output: 5, cacheRead: 300, cacheWrite: 200, totalTokens: 515 });
		expect(output.usage.cacheWrite1h ?? 0).toBe(0);
	});
	it("keeps Bedrock's own total when it is reported", async () => {
		const output = await usage({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 300, totalTokens: 315 });
		expect(output.usage.totalTokens).toBe(315);
	});
});
