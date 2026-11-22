import type { Api, Model } from "@octocodeai/octocode-ai";
import { describe, expect, test } from "vitest";
import { resolveCliModel } from "../src/core/model-resolver.ts";
import { findUnlistedModel } from "../src/core/model-resolver/suggestions.ts";

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
	};
}

const models = [
	model("anthropic", "claude-sonnet-4-5"),
	model("anthropic", "claude-opus-4-1"),
	model("openai", "gpt-4o"),
];

const runtime = { getModels: () => models, hasConfiguredAuth: () => true } as unknown as Parameters<
	typeof resolveCliModel
>[0]["modelRuntime"];

describe("mistyped model ids under a known provider", () => {
	test("the CLI keeps its warning, selects the id, and names the nearest known ids", () => {
		const result = resolveCliModel({ cliModel: "anthropic/claude-sonet-4-5", modelRuntime: runtime });
		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonet-4-5");
		expect(result.warning).toContain("Using custom model id");
		expect(result.warning).toContain("claude-sonnet-4-5");
	});

	test("no suggestion text when nothing is close", () => {
		const result = resolveCliModel({ cliModel: "anthropic/zzzzzzzzzzzzzzzzzzzz", modelRuntime: runtime });
		expect(result.warning).toContain("Using custom model id");
		expect(result.warning).not.toContain("Did you mean");
	});

	test("findUnlistedModel returns the custom model and nearest ids for provider/id text", () => {
		const found = findUnlistedModel("anthropic/claude-sonet-4-5", models);
		expect(found?.model.provider).toBe("anthropic");
		expect(found?.model.id).toBe("claude-sonet-4-5");
		expect(found?.suggestions[0]).toBe("claude-sonnet-4-5");
	});

	test("findUnlistedModel ignores listed ids, unknown providers and bare text", () => {
		expect(findUnlistedModel("anthropic/claude-sonnet-4-5", models)).toBeUndefined();
		expect(findUnlistedModel("nope/claude-sonet", models)).toBeUndefined();
		expect(findUnlistedModel("claude-sonet", models)).toBeUndefined();
	});
});
