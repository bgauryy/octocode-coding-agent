import { describe, expect, test } from "vitest";
import { emptyModelListText } from "../src/modes/interactive/components/model-selector/empty-state.ts";

/** The /models empty list says why it is empty: a search, nothing connected, or models.json providers without a key. */
const runtime = (defined: string[], keyed: string[] = []) => ({
	getDefinedProviderIds: () => defined,
	hasConfiguredAuth: (id: string) => keyed.includes(id),
});

describe("the /models empty list", () => {
	test("a search that matched nothing names the search", () => {
		expect(emptyModelListText(runtime(["gw"]), "zz")).toBe('No models match "zz"');
	});
	test("names the models.json providers that still need a key, and where to add it", () => {
		expect(emptyModelListText(runtime(["anthropic-custom", "openai-custom", "ok"], ["ok"]))).toBe(
			"No models yet: models.json defines anthropic-custom, openai-custom without a key. Add one in /providers.",
		);
		expect(emptyModelListText(runtime(["a", "b", "c", "d", "e", "f"]))).toContain("a, b, c, d and 2 more");
	});
	test("with nothing defined, points to /providers", () => {
		expect(emptyModelListText(runtime([]))).toContain("connect a provider in /providers");
	});
});
