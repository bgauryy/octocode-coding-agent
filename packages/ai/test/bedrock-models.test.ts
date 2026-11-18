/**
 * Checks the configured Amazon Bedrock model list. The request-per-model suite is `bedrock-models.live.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { getBuiltinModels } from "../src/providers/all.ts";

describe("Amazon Bedrock Models", () => {
	const models = getBuiltinModels("amazon-bedrock");

	it("should get all available Bedrock models", () => {
		expect(models.length).toBeGreaterThan(0);
		console.log(`Found ${models.length} Bedrock models`);
	});

	it("exposes Claude Opus 5 through an inference profile only", () => {
		expect(models.some((model) => model.id === "global.anthropic.claude-opus-5")).toBe(true);
		expect(models.some((model) => model.id === "anthropic.claude-opus-5")).toBe(false);
	});
});
