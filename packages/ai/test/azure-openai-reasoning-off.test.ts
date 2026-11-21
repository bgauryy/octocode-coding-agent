import { afterEach, describe, expect, it } from "vitest";
import { addAzureModels } from "../scripts/generate-models/aliases-azure-models.ts";
import { applyModelsDevReasoningOptionMetadata } from "../scripts/generate-models/thinking.ts";
import { getModelKey, modelsDevReasoningOptions } from "../scripts/generate-models/thinking-levels.ts";
import { streamSimple } from "../src/api/azure-openai-responses.ts";
import { getSupportedThinkingLevels } from "../src/models/model-helpers.ts";
import type { Api, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function openAiReasoningModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 100000,
	};
}

/** Clone, then derive each model's map from its recorded options, in the generator's order. */
function generate(models: Model<Api>[]): Model<Api>[] {
	addAzureModels(models);
	for (const model of models) applyModelsDevReasoningOptionMetadata(model);
	return models;
}

describe("Azure OpenAI Responses clones keep their source's reasoning efforts", () => {
	const id = "azure-clone-test-o-series";
	afterEach(() => {
		modelsDevReasoningOptions.delete(getModelKey({ provider: "openai", id }));
		modelsDevReasoningOptions.delete(getModelKey({ provider: "azure", id }));
	});

	it("generates the OpenAI thinking map for the Azure clone and sends no reasoning when thinking is off", async () => {
		// models.dev lists low/medium/high only for o-series models.
		modelsDevReasoningOptions.set(getModelKey({ provider: "openai", id }), [
			{ type: "effort", values: ["low", "medium", "high"] },
		]);
		const models = generate([openAiReasoningModel(id)]);
		const openai = models.find((model) => model.provider === "openai");
		const azure = models.find((model) => model.provider === "azure") as Model<"azure-openai-responses"> | undefined;
		if (!openai || !azure) throw new Error("expected both models");

		expect(azure.thinkingLevelMap).toEqual(openai.thinkingLevelMap);
		expect(getSupportedThinkingLevels(azure)).toEqual(["low", "medium", "high"]);

		const bodies: Record<string, unknown>[] = [];
		const fetchStub: typeof fetch = async (_url, init) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return Response.json({ error: { message: "intercepted" } }, { status: 400 });
		};
		const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] });
		await streamSimple({ ...azure, baseUrl: "https://example-resource.openai.azure.com/openai/v1" }, context, {
			apiKey: "test-key",
			maxRetries: 0,
			fetch: fetchStub,
		}).result();

		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.reasoning).toBeUndefined();
	});
});
