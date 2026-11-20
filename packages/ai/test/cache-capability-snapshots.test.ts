import { describe, expect, it } from "vitest";
import { azureAcceptsExtendedRetention, azureSupportsInstructionBreakpoints } from "../src/api/azure-openai-config.ts";
import { getCompat } from "../src/api/openai-responses/compat.ts";
import { baseModelId, withCacheCapabilities } from "../src/utils/cache-capabilities.ts";
import type { Api, Model } from "../src/types.ts";

function model(overrides: Partial<Model<Api>>): Model<any> {
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
	} as Model<any>;
}

describe("dated snapshot ids resolve like their base", () => {
	it("strips date suffixes only", () => {
		expect(baseModelId("gpt-5.5-2026-11-08")).toBe("gpt-5.5");
		expect(baseModelId("gpt-6-astra-20261108")).toBe("gpt-6-astra");
		expect(baseModelId("gpt-5-codex")).toBe("gpt-5-codex");
	});

	it("stamps a dated snapshot like its base, for OpenAI and Azure", () => {
		const explicit = withCacheCapabilities(model({ id: "gpt-5.6-sol-2026-12-01" }));
		expect(explicit.compat).toMatchObject({ supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true });
		expect(getCompat(withCacheCapabilities(model({ id: "gpt-5.4-2026-03-05" }))).supportsLongCacheRetention).toBe(true);
		const azure = (id: string) => withCacheCapabilities(model({ id, api: "azure-openai-responses", baseUrl: "" }));
		expect(azureSupportsInstructionBreakpoints(azure("gpt-6-astra-2026-12-01"))).toBe(true);
		expect(azureSupportsInstructionBreakpoints(azure("gpt-6-sol"))).toBe(false);
		expect(azureAcceptsExtendedRetention(azure("gpt-5.2-2026-01-01"))).toBe(true);
		expect(azureAcceptsExtendedRetention(azure("unlisted-2026-01-01"))).toBe(false);
	});

	it("keeps the compat override ahead of the flag table", () => {
		const dated = withCacheCapabilities(model({ id: "gpt-5.5-2026-11-08" }));
		expect(getCompat(dated).supportsLongCacheRetention).toBe(true);
		expect(getCompat({ ...dated, compat: { supportsLongCacheRetention: false } }).supportsLongCacheRetention).toBe(
			false,
		);
	});
});

describe("openai-responses compat baseUrl", () => {
	it("names the model and URL when baseUrl is malformed", () => {
		expect(() => getCompat(model({ provider: "custom", baseUrl: "not a url" }))).toThrow(
			/Invalid baseUrl for model "custom\/gpt-5\.5".*"not a url"/,
		);
	});
});
