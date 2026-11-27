import fs from "node:fs";
import { InMemoryCredentialStore, type Model, type Provider } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { catalogListings, indexCatalog } from "../src/core/model-catalog/index-shape.ts";
import { catalogFile, listingsFileOf, saveCatalog } from "../src/core/model-catalog/index-store.ts";
import { type BundledModelsDevSource, catalogUpdates } from "../src/core/model-catalog/merge.ts";
import { catalogUpdateOf, withCatalogUpdates } from "../src/core/model-catalog/provider.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const sibling: Model<"anthropic-messages"> = {
	id: "claude-opus-5-5",
	name: "Claude Opus 5.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	compat: { forceAdaptiveThinking: true },
	reasoning: true,
	thinkingLevelMap: { minimal: null },
	input: ["text", "image"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
};
const older: Model<"anthropic-messages"> = { ...sibling, id: "claude-opus-4-6", name: "Claude Opus 4.6" };

const listing = (fields: Record<string, unknown>) => ({
	tool_call: true,
	reasoning: true,
	family: "claude-opus",
	modalities: { input: ["text", "image"], output: ["text"] },
	limit: { context: 1_000_000, output: 128_000 },
	cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
	release_date: "2026-09-01",
	last_updated: "2026-09-01",
	...fields,
});

/** models.dev lists the bundled sibling, an older deprecated one, a new release and models that may not be added. */
const api = {
	anthropic: {
		models: {
			"claude-opus-5-5": listing({ canonical_model_id: "anthropic/claude-opus-5-5" }),
			"claude-opus-4-6": listing({ release_date: "2026-02-01", status: "deprecated" }),
			"claude-new": listing({
				name: "Claude New",
				release_date: "2026-11-20",
				last_updated: "2026-11-20",
				limit: { context: 2_000_000, output: 200_000 },
				cost: { input: 6, output: 30 },
			}),
			"claude-no-tools": listing({ tool_call: false }),
			"claude-images": listing({ modalities: { input: ["text"], output: ["image"] } }),
			"other-family-new": listing({ family: "gpt" }),
		},
	},
};

const bundled = [sibling, older];
// The manifest names the listing each provider is built from; `owners` became `sources` so a provider can read another
// listing (`zai` reads `zai-coding-plan`) and carry the ids the generator left out.
const source: BundledModelsDevSource = {
	generatedAt: Date.parse("2026-11-01"),
	sources: { anthropic: { listing: "anthropic", excluded: [] } },
};
/** The listings of the index of `apiJson` (fetched now). */
const listingsOf = (apiJson: unknown) => catalogListings(indexCatalog(apiJson, Date.now()));

describe("catalog updates", () => {
	it("adds a new model cloned from its newest same-family sibling (V1) and flags a deprecated one", () => {
		const updates = catalogUpdates("anthropic", bundled, listingsOf(api), source);
		expect(updates.added.map((model) => model.id)).toEqual(["claude-new"]);
		const added = updates.added[0] as Model<"anthropic-messages">;
		expect(added).toMatchObject({
			name: "Claude New",
			api: sibling.api,
			baseUrl: sibling.baseUrl,
			compat: sibling.compat,
			reasoning: true,
			thinkingLevelMap: sibling.thinkingLevelMap,
			input: ["text", "image"],
			cost: { input: 6, output: 30, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 2_000_000,
			maxTokens: 200_000,
		});
		expect(updates.flags.get("claude-new")).toEqual({ source: "models.dev" });
		expect(updates.flags.get("claude-opus-4-6")).toEqual({ deprecated: true });
		expect(updates.flags.get("claude-opus-5-5")).toBeUndefined();
		expect(updates.replaced.size).toBe(0);
	});

	it("replaces price and limits only for a models.dev-built provider whose listing is newer than the bundled data", () => {
		const repricedApi = {
			anthropic: {
				models: {
					"claude-opus-5-5": listing({ last_updated: "2026-11-10", cost: { input: 4, output: 20 } }),
				},
			},
		};
		const index = listingsOf(repricedApi);
		const updates = catalogUpdates("anthropic", bundled, index, source);
		expect(updates.replaced.get("claude-opus-5-5")).toMatchObject({
			api: sibling.api,
			compat: sibling.compat,
			cost: { input: 4, output: 20, cacheRead: 0.5, cacheWrite: 6.25 },
		});
		expect(updates.flags.get("claude-opus-5-5")).toEqual({ repriced: true });
		// Bundled data taken after the listing changed: nothing to replace.
		const later = { ...source, generatedAt: Date.parse("2026-11-20") };
		expect(catalogUpdates("anthropic", bundled, index, later).replaced.size).toBe(0);
		// A provider the manifest does not name keeps its price and gets no new models.
		const notOwned = catalogUpdates("anthropic", bundled, listingsOf(api), { ...source, sources: {} });
		expect(notOwned.added).toEqual([]);
		expect(notOwned.flags.get("claude-opus-4-6")).toEqual({ deprecated: true });
		expect(catalogUpdates("anthropic", bundled, index, undefined).replaced.size).toBe(0);
	});

	it("clones the sibling with the new model's id prefix, so a regional id keeps its regional endpoint", () => {
		const region = (id: string, baseUrl: string): Model<"bedrock-converse-stream"> => ({
			...(sibling as unknown as Model<"bedrock-converse-stream">),
			id,
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl,
		});
		const us = region("us.anthropic.claude-opus-5-5", "https://bedrock-runtime.us-east-1.amazonaws.com");
		const eu = region("eu.anthropic.claude-opus-5-5", "https://bedrock-runtime.eu-central-1.amazonaws.com");
		const bedrockApi = {
			"amazon-bedrock": {
				models: {
					[us.id]: listing({ release_date: "2026-09-02" }),
					[eu.id]: listing({}),
					"eu.anthropic.claude-opus-6": listing({ release_date: "2026-11-20" }),
				},
			},
		};
		const updates = catalogUpdates("amazon-bedrock", [us, eu], listingsOf(bedrockApi), {
			...source,
			sources: { "amazon-bedrock": { listing: "amazon-bedrock", excluded: [] } },
		});
		expect(updates.added.map((model) => [model.id, model.baseUrl])).toEqual([
			["eu.anthropic.claude-opus-6", eu.baseUrl],
		]);
	});

	it("never adds an id the generator left out, nor a model without a price (N2, N8)", () => {
		const extra = {
			anthropic: {
				models: {
					...api.anthropic.models,
					"claude-left-out": listing({ release_date: "2026-11-21" }),
					"claude-unpriced": listing({ release_date: "2026-11-22", cost: { input: 0, output: 0 } }),
					"claude-no-price": listing({ release_date: "2026-11-22", cost: undefined }),
				},
			},
		};
		const updates = catalogUpdates("anthropic", bundled, listingsOf(extra), {
			...source,
			sources: { anthropic: { listing: "anthropic", excluded: ["claude-left-out"] } },
		});
		expect(updates.added.map((model) => model.id)).toEqual(["claude-new"]);
	});

	it("keeps the bundled price when the newer listing lists none (a plan lists 0)", () => {
		const planApi = {
			anthropic: {
				models: {
					"claude-opus-5-5": listing({
						last_updated: "2026-11-10",
						cost: { input: 0, output: 0 },
						limit: { context: 900_000, output: 128_000 },
					}),
				},
			},
		};
		const next = catalogUpdates("anthropic", bundled, listingsOf(planApi), source).replaced.get("claude-opus-5-5");
		expect(next?.cost).toEqual(sibling.cost);
		expect(next?.contextWindow).toBe(900_000);
	});

	it("reads a provider's own models.dev listing and prices, not one named like it (zai, N2)", () => {
		const glm = (id: string, cost: { input: number; output: number }, released = "2026-09-01") =>
			listing({ family: "glm", release_date: released, last_updated: released, cost });
		const bundledGlm = {
			...(sibling as unknown as Model<"openai-completions">),
			id: "glm-5.2",
			provider: "zai",
			api: "openai-completions" as const,
		};
		const zaiApi = {
			// The coding plan: what Octocode's `zai` is built from; it lists every price as 0.
			"zai-coding-plan": {
				models: {
					"glm-5.2": glm("glm-5.2", { input: 0, output: 0 }),
					"glm-6": glm("glm-6", { input: 0, output: 0 }, "2026-11-20"),
				},
			},
			// Pay-as-you-go: prices the plan's models, and lists models the plan does not serve.
			zai: {
				models: {
					"glm-6": glm("glm-6", { input: 2, output: 8 }, "2026-11-20"),
					"glm-4.5": glm("glm-4.5", { input: 0.6, output: 2.2 }),
				},
			},
		};
		const zai = {
			generatedAt: source.generatedAt,
			sources: { zai: { listing: "zai-coding-plan", prices: "zai", excluded: [] } },
		};
		const updates = catalogUpdates("zai", [bundledGlm], listingsOf(zaiApi), zai);
		expect(updates.added.map((model) => [model.id, model.cost.input, model.cost.output])).toEqual([["glm-6", 2, 8]]);
		// Without the manifest's source the provider's own-named listing is read for deprecations only: nothing is added.
		expect(catalogUpdates("zai", [bundledGlm], listingsOf(zaiApi), undefined).added).toEqual([]);
	});

	it("leaves the catalog unchanged with no index or no listing for the provider", () => {
		for (const updates of [
			catalogUpdates("anthropic", bundled, undefined, source),
			catalogUpdates("openai", bundled, listingsOf(api), source),
		]) {
			expect(updates.added).toEqual([]);
			expect(updates.flags.size).toBe(0);
		}
	});
});

describe("withCatalogUpdates", () => {
	const provider = { id: "anthropic", name: "Anthropic", getModels: () => bundled } as unknown as Provider;
	const refresh = (wrapped: Provider) =>
		wrapped.refreshModels!({
			allowNetwork: false,
			signal: new AbortController().signal,
			publish: async ({ update }) => {
				update?.();
				return true;
			},
		});

	it("applies the updates after a refresh and reports them per model", async () => {
		const index = listingsOf(api);
		const wrapped = withCatalogUpdates(provider, { listings: () => index, bundled: () => source, enabled: () => true });
		expect(wrapped.getModels().map((model) => model.id)).toEqual(["claude-opus-5-5", "claude-opus-4-6"]);
		await refresh(wrapped);
		expect(wrapped.getModels().map((model) => model.id)).toEqual(["claude-opus-5-5", "claude-opus-4-6", "claude-new"]);
		expect(catalogUpdateOf(wrapped, "claude-new")).toEqual({ source: "models.dev" });
		expect(catalogUpdateOf(wrapped, "claude-opus-4-6")).toEqual({ deprecated: true });
		expect(catalogUpdateOf(provider, "claude-new")).toBeUndefined();
	});

	it("keeps the bundled models when updates are off", async () => {
		const index = listingsOf(api);
		const wrapped = withCatalogUpdates(provider, {
			listings: () => index,
			bundled: () => source,
			enabled: () => false,
		});
		await refresh(wrapped);
		expect(wrapped.getModels()).toEqual(bundled);
		expect(catalogUpdateOf(wrapped, "claude-opus-4-6")).toBeUndefined();
	});
});

describe("ModelRuntime catalog updates", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("flags a built-in model the saved models.dev index lists as deprecated", async () => {
		vi.stubEnv("OCTOCODE_MODELS_DEV", "1");
		const probe = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
		const model = probe.getModels("anthropic")[0];
		const file = catalogFile();
		await saveCatalog(
			file,
			indexCatalog({ anthropic: { models: { [model.id]: listing({ status: "deprecated" }) } } }, Date.now()),
		);
		// Starting reads the built-in listings file, not the whole index (N11: no full parse at process start).
		const reads = vi.spyOn(fs, "readFileSync");
		try {
			const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
			expect(runtime.getCatalogUpdate(model)).toEqual({ deprecated: true });
			expect(runtime.isModelDeprecated(model)).toBe(true);
			expect(runtime.isModelDeprecated({ provider: "anthropic", id: "not-listed" })).toBe(false);
			expect(reads.mock.calls.some(([name]) => name === file)).toBe(false);
			// Bundled wiring is untouched.
			expect(runtime.getModel("anthropic", model.id)).toEqual(model);
		} finally {
			reads.mockRestore();
			for (const saved of [file, listingsFileOf(file)]) fs.rmSync(saved, { force: true });
		}
	});
});
