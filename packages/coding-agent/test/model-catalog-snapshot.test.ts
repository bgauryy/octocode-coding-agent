import { generatedAt, providers as snapshotProviders } from "@opencode-ai/models/snapshot";
import type { Api, Model } from "@octocodeai/octocode-ai";
import { type BuiltinProvider, getBuiltinModels, getBuiltinProviders } from "@octocodeai/octocode-ai/providers/all";
import { describe, expect, it } from "vitest";
import { modelsDevSources } from "../../ai/scripts/generate-models/models-dev-sources.ts";
import { catalogListings, indexCatalog, listedModel, lookup } from "../src/core/model-catalog/index-shape.ts";
import { type BundledModelsDevSource, catalogUpdates } from "../src/core/model-catalog/merge.ts";

/**
 * The runtime catalog update against the pinned `@opencode-ai/models` snapshot and the bundled catalog, with the data
 * manifest the generator writes for them: the day a release ships, models.dev adds nothing the generator left out.
 */

/** Standard (chat) models only, as `api.json` serves them and the generator reads them. */
const api = Object.fromEntries(
	Object.entries(snapshotProviders).map(([id, provider]) => [
		id,
		{
			...provider,
			models: Object.fromEntries(Object.entries(provider.models ?? {}).filter(([, model]) => !model.type)),
		},
	]),
);
const index = indexCatalog(api, Date.parse(generatedAt));
const bundledOf = (provider: string) => getBuiltinModels(provider as BuiltinProvider) as Model<Api>[];
const stamp: BundledModelsDevSource = {
	generatedAt: Date.parse(generatedAt),
	sources: modelsDevSources(api, (provider) => bundledOf(provider).map((model) => model.id), getBuiltinProviders()),
};
const added = (source: BundledModelsDevSource | undefined) =>
	getBuiltinProviders().flatMap((provider) =>
		catalogUpdates(provider, bundledOf(provider), catalogListings(index), source).added.map(
			(model) => `${provider}/${model.id}`,
		),
	);

describe("catalog updates on the pinned snapshot", () => {
	it("adds no model the generator excludes or cannot serve (N2)", () => {
		expect(added(stamp)).toEqual([]);
	});

	it("adds a model models.dev lists after the snapshot, from the listing the provider reads", () => {
		const plan = api["zai-coding-plan"]?.models ?? {};
		const paygo = api.zai?.models ?? {};
		const glm = plan["glm-5.2"];
		const priced = paygo["glm-5.2"];
		if (!glm || !priced) throw new Error("the snapshot no longer lists glm-5.2 on both Z.ai lists");
		const later = {
			...api,
			"zai-coding-plan": { models: { ...plan, "glm-9": { ...glm, id: "glm-9", status: undefined } } },
			zai: {
				models: { ...paygo, "glm-9": { ...priced, id: "glm-9" }, "glm-9-paygo": { ...priced, id: "glm-9-paygo" } },
			},
		};
		const listings = catalogListings(indexCatalog(later, Date.now()));
		// `zai` reads the coding plan: its new model is added at the pay-as-you-go price; a pay-as-you-go-only model is not.
		expect(
			catalogUpdates("zai", bundledOf("zai"), listings, stamp).added.map((model) => [model.id, model.cost.input]),
		).toEqual([["glm-9", priced.cost?.input]]);
	});

	it("answers every provider/id from that provider's own listing, never a gateway's bare id (N3)", () => {
		const wrong: string[] = [];
		for (const provider of getBuiltinProviders()) {
			for (const id of Object.keys(api[provider]?.models ?? {})) {
				const own = indexCatalog({ [provider]: { models: { [id]: api[provider]?.models?.[id] } } }, 0).models[id];
				if (JSON.stringify(listedModel(index, provider, id)) !== JSON.stringify(own)) wrong.push(`${provider}/${id}`);
				if (JSON.stringify(lookup(index, provider, id)) !== JSON.stringify(own)) wrong.push(`lookup ${provider}/${id}`);
			}
		}
		expect(wrong).toEqual([]);
	});
});
