import { fauxAssistantMessage, type Model, type Provider } from "@octocodeai/octocode-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function model(provider: string, id = "m"): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function provider(id: string): Provider<"openai-completions"> {
	return {
		id,
		name: id,
		auth: {
			apiKey: {
				name: "API key",
				login: async () => ({ type: "api_key", key: `${id}-key` }),
				check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
				resolve: async ({ credential }) =>
					credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
			},
		},
		getModels: () => [model(id)],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

async function runtimeWithTwoProviders(): Promise<ModelRuntime> {
	const credentials = AuthStorage.inMemory({
		alpha: { type: "api_key", key: "a" },
		beta: { type: "api_key", key: "b" },
	});
	const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	for (const id of ["alpha", "beta"]) runtime.registerNativeProvider(provider(id));
	await runtime.refresh({ allowNetwork: false, providers: ["alpha", "beta"] });
	await runtime.getAvailable();
	return runtime;
}

const ids = (models: readonly Model<any>[]) => models.map((entry) => entry.provider).sort();

describe("disabled providers", () => {
	it("hide a provider's models from every availability read and restore them when enabled", async () => {
		const runtime = await runtimeWithTwoProviders();
		const registry = new ModelRegistry(runtime);
		expect(ids(runtime.getAvailableSnapshot())).toEqual(["alpha", "beta"]);

		runtime.setDisabledProviders(["alpha"]);
		expect(ids(runtime.getAvailableSnapshot())).toEqual(["beta"]);
		expect(ids(registry.getAvailable())).toEqual(["beta"]);
		expect(ids(await runtime.getAvailableOfType("chat"))).toEqual(["beta"]);
		expect((await runtime.getAllAvailable()).map((entry) => entry.provider)).not.toContain("alpha");
		expect(ids(await runtime.getAvailable())).toEqual(["beta"]);
		expect(await runtime.getAvailable("alpha")).toEqual([]);
		// Credentials and the full catalogue are untouched.
		expect(runtime.getModels("alpha")).toHaveLength(1);
		expect(runtime.hasConfiguredAuth("alpha")).toBe(true);

		runtime.setDisabledProviders([]);
		expect(ids(runtime.getAvailableSnapshot())).toEqual(["alpha", "beta"]);
	});

	it("stay hidden across a full and a per-provider availability refresh", async () => {
		const runtime = await runtimeWithTwoProviders();
		runtime.setDisabledProviders(["alpha"]);
		await runtime.getAvailable();
		expect(ids(runtime.getAvailableSnapshot())).toEqual(["beta"]);
		await runtime.refresh({ allowNetwork: false, providers: ["alpha"] });
		expect(ids(runtime.getAvailableSnapshot())).toEqual(["beta"]);
		runtime.setDisabledProviders([]);
		expect(ids(runtime.getAvailableSnapshot())).toEqual(["alpha", "beta"]);
	});

	it("leave subagent routing nothing from a disabled provider", async () => {
		// Routing, the models tool and /modelsettings read ModelRegistry.getAvailable().
		const runtime = await runtimeWithTwoProviders();
		const registry = new ModelRegistry(runtime);
		runtime.setDisabledProviders(["alpha"]);
		expect(registry.getAvailable().some((entry) => entry.provider === "alpha")).toBe(false);
		runtime.setDisabledProviders(["alpha", "beta"]);
		expect(registry.getAvailable()).toEqual([]);
	});

	it("hidden models leave every availability read, survive refreshes and return when ticked", async () => {
		const runtime = await runtimeWithTwoProviders();
		const registry = new ModelRegistry(runtime);
		runtime.setHiddenModels({ alpha: ["m"], beta: ["other"] });
		expect(ids(runtime.getAvailableSnapshot())).toEqual(["beta"]);
		expect(ids(registry.getAvailable())).toEqual(["beta"]);
		expect(registry.isModelHidden({ provider: "alpha", id: "m" })).toBe(true);
		expect(await runtime.getAvailable("alpha")).toEqual([]);
		await runtime.getAvailable();
		await runtime.refresh({ allowNetwork: false, providers: ["alpha"] });
		expect(ids(runtime.getAvailableSnapshot())).toEqual(["beta"]);
		// The catalogue and credentials are untouched.
		expect(runtime.getModels("alpha")).toHaveLength(1);
		runtime.setHiddenModels({});
		expect(ids(runtime.getAvailableSnapshot())).toEqual(["alpha", "beta"]);
	});

	it("keeps a refusal on the exact model across picker refreshes and clears it after a credential change", async () => {
		const runtime = await runtimeWithTwoProviders();
		try {
			const denied = model("alpha");
			const registry = new ModelRegistry(runtime);
			runtime.observeModelAccess({
				...fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: 'AccessDeniedException: 403 {"message":"model is not available for this account"}',
				}),
				provider: denied.provider,
				model: denied.id,
			});
			expect(registry.isModelAccessRejected(denied)).toBe(true);
			expect(() => runtime.assertModelAccess(denied)).toThrow(/alpha\/m/);
			expect(registry.isModelAccessRejected(model("alpha", "sibling"))).toBe(false);
			expect(ids(registry.getAvailable())).toEqual(["beta"]);
			expect(await runtime.getAvailable("alpha")).toEqual([]);
			expect(await runtime.getAvailableOfType("chat", "alpha")).toEqual([]);
			expect(runtime.getModel("alpha", denied.id)).toBeDefined();
			await runtime.refresh({ allowNetwork: false, providers: ["alpha"] });
			expect(registry.isModelAccessRejected(denied)).toBe(true);
			const previous = runtime.modelAccessGeneration;
			await runtime.setRuntimeApiKey("alpha", "new-test-key");
			runtime.setModelAccess(denied, true, previous);
			expect(ids(registry.getAvailable())).toEqual(["alpha", "beta"]);
		} finally {
			runtime.dispose();
		}
	});

	it("persist in the global settings only", () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getDisabledProviders()).toEqual([]);
		settings.setDisabledProviders(["alpha", "alpha", "beta"]);
		expect(settings.getDisabledProviders()).toEqual(["alpha", "beta"]);
		settings.setDisabledProviders([]);
		expect(settings.getDisabledProviders()).toEqual([]);
	});
});
