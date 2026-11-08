import { describe, expect, it } from "vitest";
import { addModelsDevFirstPartyModels } from "../scripts/generate-models/models-dev-first-party.ts";
import type { ModelsDevModel } from "../scripts/generate-models/types.ts";
import type { Api, Model } from "../src/types.ts";

function entry(id: string, status?: string): ModelsDevModel {
	return {
		id,
		name: id,
		tool_call: true,
		limit: { context: 200_000, output: 64_000 },
		cost: { input: 3, output: 15 },
		...(status ? { status } : {}),
	};
}

const SONNET_4_IDS = [
	"anthropic.claude-sonnet-4-20250514-v1:0",
	"us.anthropic.claude-sonnet-4-20250514-v1:0",
	"eu.anthropic.claude-sonnet-4-20250514-v1:0",
	"apac.anthropic.claude-sonnet-4-20250514-v1:0",
	"global.anthropic.claude-sonnet-4-20250514-v1:0",
];

function bedrockIds(catalog: Record<string, ModelsDevModel>): string[] {
	const models: Model<Api>[] = [];
	addModelsDevFirstPartyModels({ "amazon-bedrock": { models: catalog } }, models);
	return models.filter((model) => model.provider === "amazon-bedrock").map((model) => model.id);
}

describe("models.dev first-party generation", () => {
	// models.dev marks Opus 4.1 and Sonnet 4.5 deprecated while AWS still serves them; a deprecated mark alone keeps them.
	it("keeps Bedrock models that models.dev marks deprecated but AWS still serves", () => {
		const ids = [
			"us.anthropic.claude-opus-4-1-20250805-v1:0",
			"global.anthropic.claude-sonnet-4-5-20250929-v1:0",
			"us.amazon.nova-premier-v1:0",
		];
		expect(bedrockIds(Object.fromEntries(ids.map((id) => [id, entry(id, "deprecated")])))).toEqual(ids);
	});

	// AWS model card: "Claude Sonnet 4 reached end of life on October 14, 2026 and is no longer available"
	// (https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4.html).
	it("leaves out every Bedrock Sonnet 4 id, which reached end of life, whatever models.dev says", () => {
		const catalog = Object.fromEntries(
			SONNET_4_IDS.flatMap((id, index) => [[id, entry(id, index % 2 === 0 ? "deprecated" : undefined)]]),
		);
		catalog["us.anthropic.claude-sonnet-4-6"] = entry("us.anthropic.claude-sonnet-4-6");
		expect(bedrockIds(catalog)).toEqual(["us.anthropic.claude-sonnet-4-6"]);
	});
});
