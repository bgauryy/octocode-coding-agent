import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateCost, type Usage } from "@octocodeai/octocode-ai";
import { getBuiltinModels } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelDetailPanel } from "../src/modes/interactive/components/model-selector/detail-panel.ts";
import { modelDetails, userSetPrice } from "../src/modes/interactive/components/model-selector/details.ts";
import { initTheme } from "../src/theme/theme.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

/** V14: a negotiated price for an official model, set in models.json, prices replies and is marked in `/model`. */
let dir: string;
let modelsPath: string;
beforeAll(() => initTheme("dark"));
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "octocode-official-price-"));
	modelsPath = join(dir, "models.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ID = "claude-opus-5-5";
const shipped = () => {
	const model = (getBuiltinModels("anthropic" as never) as { id: string; cost: { input: number } }[]).find(
		(entry) => entry.id === ID,
	);
	if (!model) throw new Error(`no built-in anthropic/${ID}`);
	return model;
};

async function runtimeFor(override: Record<string, unknown>) {
	writeFileSync(modelsPath, JSON.stringify({ providers: { anthropic: { modelOverrides: { [ID]: override } } } }));
	const registry = await createModelRegistry(AuthStorage.inMemory(), modelsPath);
	expect(registry.getError()).toBeUndefined();
	const runtime = getModelRuntime(registry);
	const model = runtime.getModel("anthropic", ID);
	if (!model) throw new Error(`no anthropic/${ID}`);
	return { runtime, model };
}

const usage = (input: number, output: number): Usage => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("cost in an official provider's modelOverrides", () => {
	test("prices a reply at the override's rates, and details mark them as your price", async () => {
		expect(shipped().cost.input).not.toBe(0.5);
		const { runtime, model } = await runtimeFor({ cost: { input: 0.5, output: 2 } });
		expect(model.cost).toMatchObject({ input: 0.5, output: 2 });
		const cost = calculateCost(model, usage(1000, 1000), 0);
		expect(cost.input).toBeCloseTo(0.0005, 10);
		expect(cost.output).toBeCloseTo(0.002, 10);
		expect(userSetPrice(runtime, model)).toBe(true);
		const details = modelDetails(model, 0, "API key", "metered", userSetPrice(runtime, model));
		expect(details).toContain("Base USD/M tokens (your price): input $0.5 · output $2");
	});

	test("the details' first page shows your price, and billing names it instead of catalog estimates", async () => {
		const { runtime, model } = await runtimeFor({ cost: { input: 0.5, output: 2 } });
		const panel = new ModelDetailPanel(() => ({
			selected: { provider: "anthropic", id: ID, model },
			runtime,
			details: true,
			canPrefer: false,
			refresh: "",
			refreshed: false,
		}));
		const page = panel
			.render(120)
			.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))
			.join("\n");
		expect(page).toContain("Base USD/M tokens (your price): input $0.5 · output $2");
		expect(page).toContain("Billing: billed per token at your price");
		expect(page).not.toContain("catalog prices are estimates");
	});

	test("a catalog price stays unmarked, also under an override of other fields", async () => {
		const { runtime, model } = await runtimeFor({ maxTokens: 4096 });
		expect(model.cost).toEqual(shipped().cost);
		expect(userSetPrice(runtime, model)).toBe(false);
		expect(modelDetails(model, 0, "API key", "metered")).toContain("Catalog base USD/M tokens:");
	});

	test("the guard accepts cost with its nested fields and still refuses headers", async () => {
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { anthropic: { modelOverrides: { [ID]: { cost: { input: 1, tiers: [] }, maxTokens: 4096 } } } },
			}),
		);
		const accepted = await ModelConfig.loadFile(modelsPath);
		expect(accepted.getError()).toBeUndefined();
		expect(accepted.getProviderIds()).toEqual(["anthropic"]);
		writeFileSync(
			modelsPath,
			JSON.stringify({ providers: { anthropic: { modelOverrides: { [ID]: { cost: { input: 1 }, headers: {} } } } } }),
		);
		const refused = await ModelConfig.loadFile(modelsPath);
		expect(refused.getProviderIds()).toEqual([]);
		expect(refused.getError()).toContain(`modelOverrides.${ID}.headers`);
		expect(refused.getError()).toContain("never host, api, key or headers");
	});
});
