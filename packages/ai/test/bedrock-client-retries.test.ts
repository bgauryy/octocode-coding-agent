import { describe, expect, it } from "vitest";
import { buildBedrockClientConfig } from "../src/api/bedrock-converse-stream/client-config.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";

function config(maxRetries?: number) {
	const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-20250514-v1:0") as
		| Model<"bedrock-converse-stream">
		| undefined;
	if (!model) throw new Error("bedrock model missing from the catalog");
	return buildBedrockClientConfig(model, { maxRetries });
}

describe("Bedrock SDK retries", () => {
	it("makes one attempt by default so the session retry is the only retry layer", () => {
		expect(config().maxAttempts).toBe(1);
	});

	it("allows exactly maxRetries extra attempts when configured", () => {
		expect(config(2).maxAttempts).toBe(3);
		expect(config(-4).maxAttempts).toBe(1);
	});
});
