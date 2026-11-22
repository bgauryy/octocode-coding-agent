import { describe, expect, it } from "vitest";
import { indexCatalog } from "../../src/octocode/subagents/catalog.ts";
import { taskBlocker, type ModelRef } from "../../src/octocode/subagents/model.ts";
import { modelAbilities, modelLine } from "../../src/octocode/subagents/models-command.ts";

const catalog = indexCatalog(
	{
		p: {
			models: {
				priced: { tool_call: true, limit: { context: 200_000 }, cost: { input: 1, output: 5 } },
			},
		},
	},
	1,
);
const ref = (id: string, extra: Partial<ModelRef>): ModelRef => ({ provider: "p", id, ...extra });

describe("model fact sources", () => {
	it("uses configured reasoning for offline and conflicting catalog entries", () => {
		const remote = indexCatalog({ p: { models: { priced: { reasoning: true } } } }, 1);
		expect(modelAbilities(ref("custom", { reasoning: true }), undefined)).toContain("reasoning");
		expect(modelAbilities(ref("priced", { reasoning: false }), remote)).not.toContain("reasoning");
		expect(modelAbilities(ref("priced", {}), remote)).toContain("reasoning");
	});

	it("shows the prompt ceiling and excludes a route that cannot fit a subagent task", () => {
		const entry = ref("limited", { contextWindow: 300_000, inputLimits: { maxInputTokens: 60_000 } });
		expect(modelLine(entry, undefined, undefined)).toMatch(/60k max input/i);
		expect(taskBlocker(entry, undefined)).toMatch(/60k/i);
	});

	it("names models.json for an entry that sets its own price and window", () => {
		const line = modelLine(
			ref("mine", { origin: "models.json", cost: { input: 2, output: 4 }, contextWindow: 64_000 }),
			undefined,
			catalog,
		);
		expect(line).toContain("from models.json");
	});

	it("says models.dev when the price and window come from the catalog", () => {
		const line = modelLine(ref("priced", { origin: "models.json+default" }), undefined, catalog);
		expect(line).toContain("from models.dev");
	});

	it("separates a price from one source and a window from another", () => {
		const line = modelLine(
			ref("priced", { origin: "models.json+default", contextWindow: 128_000 }),
			undefined,
			catalog,
		);
		expect(line).toContain("from models.dev (price), models.json+default (window)");
	});

	it("stays silent for built-in data and for models whose origin was not looked up", () => {
		const own = { cost: { input: 2, output: 4 }, contextWindow: 64_000 };
		expect(modelLine(ref("x", { ...own, origin: "built-in" }), undefined, catalog)).not.toContain("from ");
		expect(modelLine(ref("x", own), undefined, catalog)).not.toContain("from ");
	});
});
