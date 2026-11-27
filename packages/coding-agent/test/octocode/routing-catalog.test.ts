import fs from "node:fs";
import path from "node:path";
import { generatedAt, providers as snapshotProviders } from "@opencode-ai/models/snapshot";
import type { Api, Model } from "@octocodeai/octocode-ai";
import { getBuiltinModels, getBuiltinProviders } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexCatalog, listedCost, lookup } from "../../src/core/model-catalog/index-shape.ts";
import { listingsFileOf, readCatalog, routingCatalog, saveCatalog } from "../../src/core/model-catalog/index-store.ts";
import { routingFileOf } from "../../src/core/model-catalog/routing-parts.ts";
import { routingFacts } from "../../src/octocode/subagents/models-command.ts";
import type { AgentProfile } from "../../src/octocode/subagents/profiles.ts";
import { tmp } from "./helpers.ts";

/** The pinned models.dev snapshot, indexed as a fetch would index it (chat models, as `api.json` serves them). */
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
const builtinModels = getBuiltinProviders().flatMap((provider) =>
	(getBuiltinModels(provider) as Model<Api>[]).map((model) => ({ ...model, provider })),
);

afterEach(() => vi.restoreAllMocks());

async function saved(): Promise<string> {
	const file = path.join(tmp(), "models-dev.json");
	await saveCatalog(file, index);
	return file;
}

/** Reads of the whole index file while `work` runs. */
function wholeReads(file: string, work: () => void): number {
	const reads = vi.spyOn(fs, "readFileSync");
	try {
		work();
		return reads.mock.calls.filter(([name]) => name === file).length;
	} finally {
		reads.mockRestore();
	}
}

const profiles: AgentProfile[] = [
	{ name: "coder", description: "", prompt: "", model: "medium" },
	{ name: "scout", description: "", prompt: "", model: "small" },
	{ name: "pinned", description: "", prompt: "", model: "anthropic/claude-sonnet-4-5" },
];

describe("routing reads the built-in listings, not the whole models.dev index", () => {
	it("answers every built-in model and listed id as the whole index does, without reading it", async () => {
		const file = await saved();
		const view = routingCatalog(file);
		const pairs = [
			...builtinModels.map((model) => [model.provider, model.id] as const),
			...getBuiltinProviders().flatMap((provider) =>
				Object.keys(api[provider]?.models ?? {}).map((id) => [provider, id] as const),
			),
			// Custom providers whose ids models.dev does not know: answered without the whole index too.
			["faux", "faux-1"],
			["ollama", "no-such-model:7b"],
		] as const;
		const differ: string[] = [];
		const reads = wholeReads(file, () => {
			for (const [provider, id] of pairs) {
				if (JSON.stringify(lookup(view, provider, id)) !== JSON.stringify(lookup(index, provider, id)))
					differ.push(`lookup ${provider}/${id}`);
				if (JSON.stringify(listedCost(view, provider, id)) !== JSON.stringify(listedCost(index, provider, id)))
					differ.push(`cost ${provider}/${id}`);
			}
		});
		expect(differ).toEqual([]);
		expect(reads).toBe(0);
		// The same partial index while the files are unchanged, so a routing reading keeps its identity.
		expect(routingCatalog(file)).toBe(view);
		expect(view).not.toBe(readCatalog(file));
	});

	it("reads the whole index once for a custom model whose id models.dev knows, and answers as it does", async () => {
		const file = await saved();
		const view = routingCatalog(file);
		const [known] = Object.keys(index.models);
		if (!known) throw new Error("the snapshot lists no model");
		const reads = wholeReads(file, () => {
			expect(lookup(view, "my-gateway", known)).toEqual(lookup(index, "my-gateway", known));
			expect(lookup(view, "my-gateway", `vendor/${known}`)).toEqual(lookup(index, "my-gateway", `vendor/${known}`));
		});
		expect(reads).toBe(1);
	});

	it("routes identically on the pinned snapshot", async () => {
		const file = await saved();
		const view = routingCatalog(file);
		const available = [
			...builtinModels.filter((model) =>
				["anthropic", "openai", "google", "zai", "openrouter"].includes(model.provider),
			),
			{ provider: "faux", id: "faux-1", cost: { input: 3, output: 15 }, contextWindow: 128_000 },
		];
		const parent = available.find((model) => model.provider === "anthropic");
		if (!parent) throw new Error("no built-in Anthropic model");
		const route = (catalog: typeof index | undefined) =>
			routingFacts(available, parent, profiles, catalog, () => false, {}, undefined);
		const viaView: Array<ReturnType<typeof route>> = [];
		const reads = wholeReads(file, () => viaView.push(route(view)));
		expect(viaView[0]).toEqual(route(index));
		expect(viaView[0]?.medium).toBeTruthy();
		expect(reads).toBe(0);
	});

	it("uses the whole index without routing parts (an earlier Octocode saved it) or when the files are not one fetch", async () => {
		const file = await saved();
		const parts = fs.readFileSync(routingFileOf(file), "utf8");
		fs.rmSync(routingFileOf(file));
		expect(routingCatalog(file)).toBe(readCatalog(file));
		fs.writeFileSync(routingFileOf(file), parts);
		expect(routingCatalog(file)).not.toBe(readCatalog(file));
		const small = JSON.parse(fs.readFileSync(listingsFileOf(file), "utf8")) as Record<string, unknown>;
		fs.writeFileSync(listingsFileOf(file), JSON.stringify({ ...small, fetchedAt: index.fetchedAt - 1 }));
		expect(routingCatalog(file)).toBe(readCatalog(file));
	});

	it("keeps the start path's listings file small: the routing parts live beside it", async () => {
		const file = await saved();
		const small = JSON.parse(fs.readFileSync(listingsFileOf(file), "utf8")) as Record<string, unknown>;
		expect(Object.keys(small).sort()).toEqual(["covers", "fetchedAt", "listings", "version"]);
		expect(fs.statSync(routingFileOf(file)).size).toBeLessThan(fs.statSync(file).size / 5);
	});
});
