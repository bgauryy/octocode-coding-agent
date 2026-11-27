import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { planRun } from "../../src/octocode/subagents/claim.ts";
import { registryBilling } from "../../src/octocode/subagents/model.ts";
import { modelAvailableToChild, sessionOnlyProvider } from "../../src/octocode/subagents/task-model-visibility.ts";

it("routes children using their own shared credential when a parent overrides its API key", async () => {
	const dir = mkdtempSync(join(tmpdir(), "octocode-task-credentials-"));
	const authPath = join(dir, "auth.json");
	const modelsPath = join(dir, "models.json");
	const custom = { api: "openai-completions", baseUrl: "https://provider.invalid", models: [{ id: "chat" }] };
	writeFileSync(modelsPath, JSON.stringify({ providers: { configured: { ...custom, apiKey: "model-file-key" } } }));
	writeFileSync(authPath, JSON.stringify({ groq: { type: "api_key", key: "saved-key" } }));
	vi.stubEnv("GROQ_API_KEY", undefined);
	vi.stubEnv("DEEPSEEK_API_KEY", undefined);
	vi.stubEnv("XAI_API_KEY", "environment-key");
	let runtime: ModelRuntime | undefined;
	try {
		runtime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false });
		const registry = new ModelRegistry(runtime);
		const providers = ["configured", "groq", "deepseek", "xai"];
		for (const provider of providers) await runtime.setRuntimeApiKey(provider, "parent-session-key");
		const verify = (current: ModelRuntime) => {
			for (const provider of providers) {
				expect(registry.getProviderAuthStatus(provider).source).toBe("runtime");
				expect(sessionOnlyProvider(registry, provider), provider).toBe(provider === "deepseek");
				expect(modelAvailableToChild(registry, current.getModels(provider)[0]), provider).toBe(provider !== "deepseek");
			}
		};
		verify(runtime);
		await runtime.getAvailable();
		verify(runtime);

		const child = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false });
		try {
			expect(await Promise.all(providers.map(async (id) => (await child.getAuth(id))?.auth.apiKey))).toEqual([
				"model-file-key",
				"saved-key",
				undefined,
				"environment-key",
			]);
		} finally {
			child.dispose();
		}
	} finally {
		runtime?.dispose();
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	}
});

it.each(["openai", "github-copilot"])("routes only models in the child's %s subscription catalog", async (provider) => {
	const credentials = AuthStorage.inMemory();
	const options = { credentials, modelsPath: null, allowModelNetwork: false };
	const runtime = await ModelRuntime.create(options);
	try {
		const [allowed, parentOnly] = runtime.getModels(provider);
		const subscription = {
			type: "oauth" as const,
			access: "fixture-access",
			refresh: "fixture-refresh",
			expires: Date.now() + 3_600_000,
			...(provider === "openai" ? { availableModels: [{ id: allowed.id }] } : { availableModelIds: [allowed.id] }),
		};
		await runtime.importCredential(provider, subscription);
		await runtime.setRuntimeApiKey(provider, "fixture-override");
		const registry = new ModelRegistry(runtime);
		const child = await ModelRuntime.create(options);
		try {
			expect(registryBilling(registry).plan?.(provider)).toBe(true);
			expect(registry.getProviderBilling(provider, "child")).toBe(child.getProviderBilling(provider));
			expect(registry.getProviderBilling(provider)).toBe(provider === "openai" ? "metered" : "plan");
			expect((await child.getAvailable(provider)).map((m) => m.id)).toEqual([allowed.id]);
			expect((await runtime.getAvailable(provider)).map((m) => m.id)).toContain(parentOnly.id);
			for (const model of runtime.getModels(provider)) {
				expect(modelAvailableToChild(registry, model), model.id).toBe(model.id === allowed.id);
			}
			const ctx = { modelRegistry: registry, model: parentOnly };
			expect(() => planRun(new Map(), { model: `${provider}/${parentOnly.id}` }, ctx)).toThrow(
				/child account cannot use/,
			);
			expect(planRun(new Map(), { model: `${provider}/${allowed.id}` }, ctx).route.model).toContain(
				`${provider}/${allowed.id}`,
			);
			await runtime.importCredential(provider, { ...subscription, availableModels: [], availableModelIds: [] });
			expect(sessionOnlyProvider(registry, provider)).toBe(false);
			expect(modelAvailableToChild(registry, allowed)).toBe(false);
		} finally {
			child.dispose();
		}
	} finally {
		runtime.dispose();
	}
});
