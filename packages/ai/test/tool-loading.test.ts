import { describe, expect, test } from "vitest";
import type { Api, Model } from "../src/types.ts";
import { getToolLoadingMode, supportsNativeToolLoading } from "../src/utils/tool-loading.ts";

function model(api: Api, compat?: Record<string, boolean>): Model<Api> {
	return {
		id: "m",
		name: "m",
		api,
		provider: "p",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
		compat,
	};
}

describe("getToolLoadingMode", () => {
	test("is none without mid-conversation system messages, whatever else is declared", () => {
		for (const api of [
			"anthropic-messages",
			"openai-responses",
			"openai-codex-responses",
			"openai-completions",
		] as const) {
			expect(
				getToolLoadingMode(
					model(api, {
						supportsMidConvoToolChanges: true,
						supportsMidConvoToolAdditions: true,
						supportsAdditionalTools: true,
						supportsToolSearch: true,
					}),
				),
			).toBe("none");
		}
	});

	test("anthropic needs supportsMidConvoToolChanges", () => {
		expect(getToolLoadingMode(model("anthropic-messages", { supportsMidConvoSystemMessages: true }))).toBe("none");
		expect(
			getToolLoadingMode(
				model("anthropic-messages", { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true }),
			),
		).toBe("changes");
	});

	test.each(["openai-responses", "openai-codex-responses", "azure-openai-responses"] as const)(
		"%s prefers additional tools, then tool search",
		(api) => {
			const base = { supportsMidConvoSystemMessages: true };
			expect(getToolLoadingMode(model(api, base))).toBe("none");
			expect(getToolLoadingMode(model(api, { ...base, supportsToolSearch: true }))).toBe("additions");
			expect(getToolLoadingMode(model(api, { ...base, supportsToolSearch: true, supportsAdditionalTools: true }))).toBe(
				"changes",
			);
		},
	);

	test("openai-completions needs tool additions", () => {
		expect(getToolLoadingMode(model("openai-completions", { supportsMidConvoSystemMessages: true }))).toBe("none");
		expect(
			getToolLoadingMode(
				model("openai-completions", { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true }),
			),
		).toBe("additions");
	});

	test("other APIs and missing compat are none", () => {
		expect(getToolLoadingMode(model("mistral-conversations", { supportsMidConvoSystemMessages: true }))).toBe("none");
		expect(getToolLoadingMode(model("openai-responses"))).toBe("none");
	});
});

describe("supportsNativeToolLoading", () => {
	test("is true for any mode but none", () => {
		expect(supportsNativeToolLoading(undefined)).toBe(false);
		expect(supportsNativeToolLoading(model("openai-responses"))).toBe(false);
		expect(
			supportsNativeToolLoading(
				model("openai-responses", { supportsMidConvoSystemMessages: true, supportsToolSearch: true }),
			),
		).toBe(true);
	});
});
