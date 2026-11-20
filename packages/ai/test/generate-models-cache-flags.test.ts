import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCacheFlagTable, serializeCacheFlagTable } from "../scripts/generate-models/cache-flags.ts";
import { applyOpenAIExplicitPromptCacheMetadata } from "../scripts/generate-models/openai-compat.ts";
import type { Api, Model } from "../src/types.ts";
import type { CacheFlagTable } from "../src/utils/cache-capability-data.ts";
import { withCacheFlags } from "../src/utils/cache-capabilities.ts";

function model(overrides: Partial<Model<Api>>): Model<Api> {
	return {
		id: "gpt-5.5",
		name: "m",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		...overrides,
	};
}

describe("generated cache flag table", () => {
	const table = buildCacheFlagTable();

	it("carries one flag set per documented model and host", () => {
		expect(table.openai["gpt-5.6-sol"]).toEqual({ explicitMode: true });
		expect(table.openai["gpt-5.4"]).toEqual({ longRetention: true });
		expect(table.azure["gpt-6-astra"]).toEqual({ instructionBreakpoints: true });
		expect(table.azure["gpt-5.1-chat"]).toEqual({ longRetention: true });
		expect(table.openrouter["qwen/qwen3-max"]).toEqual({ explicitMarkers: true });
		expect(table.openai["gpt-9-new"]).toBeUndefined();
	});

	it("matches the checked-in module the runtime reads", () => {
		const path = new URL("../src/utils/cache-capability-flags.generated.ts", import.meta.url);
		expect(readFileSync(path, "utf8")).toBe(serializeCacheFlagTable(table));
	});
});

describe("withCacheFlags", () => {
	const fixture: CacheFlagTable = {
		openai: { "fixture-explicit": { explicitMode: true }, "fixture-long": { longRetention: true } },
		azure: { "fixture-azure": { instructionBreakpoints: true, longRetention: true } },
		openrouter: { "fixture/marked": { explicitMarkers: true } },
	};

	it("stamps the flags of the table it is given, dated snapshots included", () => {
		expect(withCacheFlags(model({ id: "fixture-explicit-2026-12-01" }), fixture).compat).toEqual({
			supportsExplicitPromptCacheMode: true,
			supportsLongCacheRetention: true,
		});
		expect(withCacheFlags(model({ id: "fixture-long" }), fixture).compat).toEqual({ supportsLongCacheRetention: true });
		expect(
			withCacheFlags(model({ id: "fixture-azure", api: "azure-openai-responses", baseUrl: "" }), fixture).compat,
		).toEqual({ supportsInstructionBreakpoints: true, supportsLongCacheRetention: true });
		expect(
			withCacheFlags(
				model({
					id: "fixture/marked",
					provider: "openrouter",
					api: "openai-completions",
					baseUrl: "https://openrouter.ai/api/v1",
				}),
				fixture,
			).compat,
		).toEqual({ cacheControlFormat: "anthropic", supportsLongCacheRetention: false });
	});

	it("leaves ids the table lacks on the safe default, including inherited object keys", () => {
		expect(withCacheFlags(model({ id: "gpt-5.5" }), fixture).compat).toBeUndefined();
		expect(withCacheFlags(model({ id: "constructor" }), fixture).compat).toBeUndefined();
	});

	it("keeps an explicit compat value ahead of the table", () => {
		const own = model({ id: "fixture-long", compat: { supportsLongCacheRetention: false } });
		expect(withCacheFlags(own, fixture).compat).toEqual({ supportsLongCacheRetention: false });
	});
});

describe("applyOpenAIExplicitPromptCacheMetadata", () => {
	it("stamps catalog models from the generator's own table", () => {
		const explicit = model({ id: "gpt-6-sol" });
		applyOpenAIExplicitPromptCacheMetadata(explicit);
		expect(explicit.compat).toMatchObject({ supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true });
		const plain = model({ id: "gpt-4o" });
		applyOpenAIExplicitPromptCacheMetadata(plain);
		expect(plain.compat).toBeUndefined();
	});
});
