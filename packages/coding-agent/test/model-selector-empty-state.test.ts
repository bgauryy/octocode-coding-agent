import { describe, expect, test } from "vitest";
import { emptyModelListText } from "../src/modes/interactive/components/model-selector/empty-state.ts";

/** The /models empty list says why it is empty: a search, nothing connected, or models.json providers without a key. */
const runtime = (defined: string[], keyed: string[] = []) => ({
	getDefinedProviderIds: () => defined,
	hasConfiguredAuth: (id: string) => keyed.includes(id),
});

describe("the /models empty list", () => {
	test("a search that matched nothing says so", () => {
		expect(emptyModelListText(runtime(["gw"]), true)).toBe("No matching models");
	});
	test("names the models.json providers that still need a key, and where to add it", () => {
		expect(emptyModelListText(runtime(["anthropic-custom", "openai-custom", "ok"], ["ok"]), false)).toBe(
			"No models yet: models.json defines anthropic-custom, openai-custom without a key. Add one in /providers.",
		);
		expect(emptyModelListText(runtime(["a", "b", "c", "d", "e", "f"]), false)).toContain("a, b, c, d and 2 more");
	});
	test("with nothing defined, points to /providers", () => {
		expect(emptyModelListText(runtime([]), false)).toContain("connect a provider in /providers");
	});
});
