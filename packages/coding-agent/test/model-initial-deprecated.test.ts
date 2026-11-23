import type { Api, Model } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { defaultModelPerProvider, findInitialModel } from "../src/core/model-resolver.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

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

const anthropicDefault = makeModel("anthropic", defaultModelPerProvider.anthropic!);
const anthropicOther = makeModel("anthropic", "claude-other");
const openaiDefault = makeModel("openai", defaultModelPerProvider.openai!);
const key = (model: Pick<Model<Api>, "provider" | "id">) => `${model.provider}/${model.id}`;

async function select(
	models: Model<Api>[],
	deprecated: readonly Model<Api>[],
	options: Partial<Parameters<typeof findInitialModel>[0]> = {},
) {
	const gone = new Set(deprecated.map(key));
	const modelRuntime = {
		getAvailableSnapshot: () => models,
		getProviderBilling: () => "metered",
		allowsUnattendedUse: () => true,
		getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		hasConfiguredAuth: () => true,
		isModelDeprecated: (model: Pick<Model<Api>, "provider" | "id">) => gone.has(key(model)),
		getProvider: (provider: string) => ({ id: provider }),
		isProviderDisabled: () => false,
		getPlanDisabledReason: () => undefined,
		isModelHidden: () => false,
	} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];
	return findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime, ...options });
}

describe("initial model choice skips models models.dev lists as deprecated", () => {
	afterEach(() => vi.restoreAllMocks());

	it("passes over a deprecated built-in default to the next provider's", async () => {
		expect((await select([anthropicDefault, openaiDefault], [anthropicDefault])).model).toBe(openaiDefault);
	});

	it("passes over a deprecated built-in default of the default provider to its other model", async () => {
		const result = await select([anthropicDefault, anthropicOther, openaiDefault], [anthropicDefault], {
			defaultProvider: "anthropic",
		});
		expect(result.model).toBe(anthropicOther);
	});

	it("never falls back to a deprecated model while another is available", async () => {
		// Neither provider has a built-in default, so the first available model of the catalog would be taken.
		const old = makeModel("custom-a", "old");
		const custom = makeModel("custom-gw", "only");
		expect((await select([old, custom], [old])).model).toBe(custom);
	});

	it("keeps a saved default the user chose by exact id", async () => {
		const result = await select([anthropicDefault, openaiDefault], [anthropicDefault], {
			defaultProvider: "anthropic",
			defaultModelId: anthropicDefault.id,
		});
		expect(result.model).toBe(anthropicDefault);
		expect(result.fallbackMessage).toBeUndefined();
	});

	it("keeps the user's per-provider default (providerModels)", async () => {
		const result = await select([anthropicDefault, anthropicOther, openaiDefault], [anthropicOther], {
			providerModels: { anthropic: anthropicOther.id },
		});
		expect(result.model).toBe(anthropicOther);
	});

	it("still starts on a deprecated model when it is the only one available", async () => {
		expect((await select([anthropicDefault], [anthropicDefault])).model).toBe(anthropicDefault);
	});

	it("reads deprecation from the runtime's catalog update", async () => {
		const runtime = getModelRuntime(await createInMemoryModelRegistry(AuthStorage.inMemory()));
		vi.spyOn(runtime, "hasConfiguredAuth").mockImplementation((provider) => provider === "anthropic");
		const available = runtime.getModels().filter((model) => model.provider === "anthropic");
		vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue(available);
		const update = runtime.getCatalogUpdate.bind(runtime);
		vi.spyOn(runtime, "getCatalogUpdate").mockImplementation((model) =>
			model.provider === "anthropic" && model.id === defaultModelPerProvider.anthropic
				? { deprecated: true }
				: update(model),
		);

		const result = await findInitialModel({ scopedModels: [], isContinuing: false, modelRuntime: runtime });

		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).not.toBe(defaultModelPerProvider.anthropic);
		expect(runtime.isModelDeprecated(result.model!)).toBe(false);
	});
});
