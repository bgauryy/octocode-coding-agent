import { describe, expect, it } from "vitest";
import { detectOpenAICompletionsCompat } from "../scripts/generate-models/openai-compat.ts";
import type { Model } from "../src/types.ts";

function model(provider: string, baseUrl: string): Model<"openai-completions"> {
	return {
		id: "beam-free",
		name: "Beam Free",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

describe("generated strict tool mode", () => {
	it.each([
		["opencode", "https://opencode.ai/inference/v1"],
		["opencode-go", "https://opencode.ai/inference/go/v1"],
		["custom", "https://opencode.ai/other"],
	])("is off for the OpenCode gateway %s, which fronts vendors that refuse strict schemas", (provider, baseUrl) => {
		expect(detectOpenAICompletionsCompat(model(provider, baseUrl)).supportsStrictMode).toBe(false);
	});

	it("stays on for a first-party OpenAI-compatible provider", () => {
		expect(detectOpenAICompletionsCompat(model("groq", "https://api.groq.com/openai/v1")).supportsStrictMode).toBe(
			true,
		);
	});
});
