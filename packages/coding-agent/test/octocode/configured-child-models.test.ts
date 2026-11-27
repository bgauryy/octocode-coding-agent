import { join } from "node:path";
import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { expect, it, vi } from "vitest";
import type { ToolContext, ToolDefinition } from "../../src/core/features/index.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { applyProviderVisibility, setProviderHiddenModels } from "../../src/core/provider-models.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { registerModelsTool } from "../../src/octocode/native/tools/models/tool.ts";
import { MODELS_DEV_ENV } from "../../src/core/model-catalog/index-store.ts";
import { planRun } from "../../src/octocode/subagents/claim.ts";
import { createSandbox, write } from "../discovery/fixtures.ts";
import { asSetup } from "./fake-host.ts";

it("discovers and dispatches provider-qualified models from both files and follows user visibility changes", async () => {
	const sandbox = createSandbox();
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"));
	vi.stubEnv(MODELS_DEV_ENV, "0");
	const id = "studio/compact-fixture";
	const octocode = "fixture-octocode";
	const pi = "fixture-pi";
	const providers = [octocode, pi];
	const ref = (provider: string) => `${provider}/${id}`;
	let runtime: ModelRuntime | undefined;
	try {
		for (const [provider, directory, contextWindow] of [
			[octocode, sandbox.agentDir, 8192],
			[pi, sandbox.piAgentDir, 16384],
		] as const) {
			write(
				join(directory, "models.json"),
				JSON.stringify({
					providers: {
						[provider]: {
							baseUrl: `https://${provider}.invalid/v1`,
							api: "openai-completions",
							apiKey: "fixture-key",
							models: [{ id, contextWindow, maxTokens: 2048, reasoning: false }],
						},
					},
				}),
			);
		}
		runtime = await ModelRuntime.create({ modelsStore: new InMemoryModelsStore(), allowModelNetwork: false });
		const modelRegistry = new ModelRegistry(runtime);
		const ctx = { modelRegistry, model: undefined };
		const settings = SettingsManager.create(sandbox.cwd, sandbox.agentDir);
		const registerTool = vi.fn<(tool: ToolDefinition) => void>();
		// The quota notice registers with the tool (`models-quota-notice.ts`); no event fires here.
		registerModelsTool(asSetup({ registerTool, on: () => () => undefined }), () => new Map());
		const tool = registerTool.mock.calls[0][0];
		const list = async (scope: "connected" | "catalog") => {
			const result = await tool.execute("models", { scope, query: id }, undefined, undefined, ctx as ToolContext);
			return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		};
		const dispatch = (model: string) => planRun(new Map(), { model }, ctx).route.model;

		expect(modelRegistry.getError()).toBeUndefined();
		expect(
			modelRegistry
				.getAvailable()
				.filter((model) => model.id === id)
				.sort((a, b) => a.provider.localeCompare(b.provider))
				.map((model) => [model.provider, model.contextWindow]),
		).toEqual([
			[octocode, 8192],
			[pi, 16384],
		]);
		const initial = await list("connected");
		for (const provider of providers) {
			expect(initial).toContain(ref(provider));
			expect(dispatch(ref(provider))).toBe(ref(provider) + ":off");
		}
		expect(() => dispatch(id)).toThrow(/matches several providers/);

		setProviderHiddenModels(settings, octocode, [id]);
		settings.setDisabledProviders([pi]);
		await settings.flush();
		applyProviderVisibility(runtime, SettingsManager.create(sandbox.cwd, sandbox.agentDir));
		expect(modelRegistry.getAll().filter((model) => model.id === id)).toHaveLength(2);
		expect(modelRegistry.getAvailable().filter((model) => model.id === id)).toHaveLength(0);
		for (const scope of ["connected", "catalog"] as const) {
			const listing = await list(scope);
			for (const provider of providers) expect(listing).not.toContain(ref(provider));
		}
		for (const provider of providers) expect(() => dispatch(ref(provider))).toThrow(/is not available/);

		settings.setDisabledProviders([]);
		await settings.flush();
		applyProviderVisibility(runtime, settings);
		const enabled = await list("catalog");
		expect(enabled).toContain(ref(pi));
		expect(enabled).not.toContain(ref(octocode));
		expect(dispatch(id)).toBe(ref(pi) + ":off");
		expect(() => dispatch(ref(octocode))).toThrow(/is not available/);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		runtime?.dispose();
		fetch.mockRestore();
		sandbox.cleanup();
	}
});
