import { truncateToWidth } from "@octocodeai/octocode-tui";
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
		// `/providers` leads: the list cuts its empty line to the width (40 columns still show it).
		expect(emptyModelListText(runtime(["anthropic-custom", "openai-custom", "ok"], ["ok"]))).toBe(
			"No models: add a key in /providers; models.json defines anthropic-custom, openai-custom without one.",
		);
		expect(emptyModelListText(runtime(["a", "b", "c", "d", "e", "f"]))).toContain("a, b, c, d and 2 more");
	});
	test("with nothing defined, points to /providers", () => {
		expect(emptyModelListText(runtime([]))).toContain("open /providers to connect one");
	});
	test("the empty line still names /providers when the list cuts it to 40 columns", () => {
		for (const text of [emptyModelListText(runtime([])), emptyModelListText(runtime(["a-very-long-provider-id"]))])
			expect(truncateToWidth(`  ${text}`, 40, "…")).toContain("/providers");
	});
});
