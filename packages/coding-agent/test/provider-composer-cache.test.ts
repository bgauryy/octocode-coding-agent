import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model, Provider } from "@octocodeai/octocode-ai";
import { getBuiltinModels } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, describe, expect, it } from "vitest";
import { withCatalogUpdates } from "../src/core/model-catalog/provider.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import type { KnownModelLookup } from "../src/core/provider-composer/known-models.ts";
import { countingPublications, publishedModelLists } from "../src/core/provider-composer/model-lists.ts";

type RefreshContext = Parameters<NonNullable<Provider["refreshModels"]>>[0];

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function gatewayConfig(): Promise<ModelConfig> {
	const dir = mkdtempSync(join(tmpdir(), "octocode-composer-cache-"));
	dirs.push(dir);
	const path = join(dir, "models.json");
	const gateway = {
		baseUrl: "https://gateway.test/v1",
		api: "openai-completions",
		apiKey: "k",
		models: [{ id: "known" }],
	};
	writeFileSync(path, JSON.stringify({ providers: { gateway } }));
	return ModelConfig.load(path);
}

/** The vendor model a gateway entry names (`known-models.ts`), priced by `price`, counting its lookups. */
function vendor() {
	const [first] = getBuiltinModels("openai") as Model<Api>[];
	if (!first) throw new Error("no built-in openai model");
	const template: Model<Api> = { ...first, api: "openai-completions" };
	const state = { price: 1, lookups: 0 };
	const known: KnownModelLookup = (api, id) => {
		state.lookups++;
		return id === "known" && api === "openai-completions"
			? { ...template, id, cost: { ...template.cost, input: state.price } }
			: undefined;
	};
	return { state, known };
}

/** A refresh context whose publications apply at once, as the refresher's do. */
const refreshContext = (): RefreshContext => ({
	allowNetwork: false,
	signal: new AbortController().signal,
	publish: async (publication) => {
		publication.update?.();
		return true;
	},
});

describe("a composed provider's model list", () => {
	it("is composed once between publications, and again after one: each read gets its own array", async () => {
		const { state, known } = vendor();
		const provider = composeModelProvider("gateway", undefined, await gatewayConfig(), undefined, known);
		const composed = state.lookups;
		const first = provider.getModels();
		const again = provider.getModels();
		for (let index = 0; index < 20; index++) provider.getAllModels?.();
		expect(state.lookups).toBe(composed);
		expect(again).not.toBe(first);
		expect(again).toEqual(first);
		expect(first[0]?.cost.input).toBe(1);
		// A persist-only publication changes no list.
		await countingPublications(refreshContext()).publish({ persist: { models: [], checkedAt: 1 } });
		provider.getModels();
		expect(state.lookups).toBe(composed);
		// A vendor list published anew (a catalog update repriced the model the entry names): composed again.
		await countingPublications(refreshContext()).publish({ update: () => (state.price = 2) });
		expect(provider.getModels()[0]?.cost.input).toBe(2);
		expect(state.lookups).toBeGreaterThan(composed);
	});

	it("counts the publications of a built-in provider's catalog-update refresh", async () => {
		let models: Model<Api>[] = [];
		const builtin: Provider = {
			id: "fixture",
			name: "fixture",
			auth: { apiKey: { name: "key", resolve: async () => ({ auth: {}, source: "test" }) } },
			getModels: () => models,
			refreshModels: async (context) => {
				await context.publish({ update: () => (models = [...models]) });
			},
			stream: () => {
				throw new Error("not streamed");
			},
			streamSimple: () => {
				throw new Error("not streamed");
			},
		};
		const wrapped = withCatalogUpdates(builtin, { enabled: () => false });
		const before = publishedModelLists();
		await wrapped.refreshModels?.(refreshContext());
		// The built-in provider's own publication and the catalog update's.
		expect(publishedModelLists()).toBe(before + 2);
	});
});
