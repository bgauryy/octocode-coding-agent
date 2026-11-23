import type { Api, Model } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { defaultModelPerProvider, findInitialModel } from "../src/core/model-resolver.ts";

const makeModel = (provider: string, id: string): Model<"openai-completions"> => ({
	provider,
	id,
	name: id,
	api: "openai-completions",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 4096,
});

const metered = makeModel("anthropic", defaultModelPerProvider.anthropic!);
const cliPlan = makeModel("claude-code", "sonnet");
const catalogPlan = makeModel("openai-codex", "available-plan-model");

async function select(
	models: Model<Api>[],
	options: Partial<Parameters<typeof findInitialModel>[0]> = {},
	interactiveOnly: string[] = [],
) {
	const modelRuntime = {
		getAvailableSnapshot: () => models,
		isModelDeprecated: () => false,
		getProviderBilling: (provider: string) => (provider === metered.provider ? "metered" : "plan"),
		allowsUnattendedUse: (provider: string) => !interactiveOnly.includes(provider),
		getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		hasConfiguredAuth: () => true,
	} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];
	return (await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime, ...options })).model;
}

describe("initial model billing preference", () => {
	it("uses a connected CLI plan before a metered provider with a catalog default", async () => {
		expect(await select([metered, cliPlan])).toBe(cliPlan);
	});

	it("uses an available plan model when its catalog default is unavailable", async () => {
		expect(await select([metered, catalogPlan])).toBe(catalogPlan);
	});

	it("retains an explicit saved metered selection", async () => {
		expect(await select([metered, cliPlan], { defaultProvider: metered.provider, defaultModelId: metered.id })).toBe(
			metered,
		);
	});

	it("skips an interactive-only fallback plan for an unattended run", async () => {
		expect(await select([metered, cliPlan], { unattended: true }, [cliPlan.provider])).toBe(metered);
	});

	it("retains the only available interactive-only plan for an unattended run", async () => {
		expect(await select([cliPlan], { unattended: true }, [cliPlan.provider])).toBe(cliPlan);
	});
});
