import type { Api, Model } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import type { ModelsJsonModel } from "../src/core/model-config.ts";
import { applyModelsJson } from "../src/core/provider-composer/models.ts";

function define(provider: string, id: string, extra: Partial<ModelsJsonModel> = {}): Model<Api> | undefined {
	const models = applyModelsJson(provider, [], {
		api: "openai-responses",
		baseUrl: "https://example.test/v1",
		models: [{ id, reasoning: true, ...extra }],
	});
	return models[0] as Model<Api> | undefined;
}

describe("models.json effort levels", () => {
	it("gives a reasoning model without a map the catalog rules for its id", () => {
		expect(define("my-proxy", "gpt-5.5")?.thinkingLevelMap).toMatchObject({ off: null, xhigh: "xhigh" });
		expect(define("my-proxy", "claude-opus-4-8")?.thinkingLevelMap).toMatchObject({ xhigh: "xhigh", max: "max" });
	});

	it("keeps a map the entry declares", () => {
		const thinkingLevelMap = { high: "high" };
		expect(define("my-proxy", "gpt-5.5", { thinkingLevelMap })?.thinkingLevelMap).toEqual(thinkingLevelMap);
	});

	it("adds no map when no rule matches or the model does not reason", () => {
		expect(define("my-proxy", "llama-3")?.thinkingLevelMap).toBeUndefined();
		expect(define("my-proxy", "gpt-5.5", { reasoning: false })?.thinkingLevelMap).toBeUndefined();
	});
});
