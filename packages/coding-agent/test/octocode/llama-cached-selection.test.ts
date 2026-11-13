import { InMemoryModelsStore } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionFromServices } from "../../src/core/agent-session/create-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { findInitialModel, resolveCliModel } from "../../src/core/model-resolver.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createLlamaProvider, LLAMA_PROVIDER_ID } from "../../src/octocode/llama/provider.ts";
import { createTestResourceLoader, userMsg } from "../utilities.ts";

afterEach(() => vi.unstubAllGlobals());

async function cachedRuntime(): Promise<ModelRuntime> {
	vi.stubGlobal(
		"fetch",
		vi.fn(() => Promise.reject(new Error("Unexpected network request"))),
	);
	const seed = createLlamaProvider();
	seed.setCatalog(
		[
			{ id: "saved-default", status: { value: "loaded" }, meta: { n_ctx: 4096 } },
			{ id: "previous-model", status: { value: "sleeping" }, meta: { n_ctx: 8192 } },
		],
		"http://localhost:8080",
	);
	const modelsStore = new InMemoryModelsStore();
	await modelsStore.write(LLAMA_PROVIDER_ID, { models: seed.provider.getModels() });
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({
			[LLAMA_PROVIDER_ID]: { type: "api_key", env: { LLAMA_BASE_URL: "http://localhost:8080" } },
		}),
		modelsPath: null,
		modelsStore,
		allowModelNetwork: false,
	});
	runtime.registerNativeProvider(createLlamaProvider().provider);
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

describe("cached llama.cpp model selection", () => {
	it("resolves saved defaults and explicit CLI references without contacting the router", async () => {
		const runtime = await cachedRuntime();
		try {
			const initial = await findInitialModel({
				scopedModels: [],
				isContinuing: false,
				defaultProvider: LLAMA_PROVIDER_ID,
				defaultModelId: "saved-default",
				modelRuntime: runtime,
			});
			expect(initial.model).toMatchObject({ provider: LLAMA_PROVIDER_ID, id: "saved-default", contextWindow: 4096 });
			const explicit = resolveCliModel({ cliModel: "llama.cpp/previous-model", modelRuntime: runtime });
			expect(explicit.error).toBeUndefined();
			expect(explicit.model).toMatchObject({ provider: LLAMA_PROVIDER_ID, id: "previous-model", contextWindow: 8192 });
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			runtime.dispose();
		}
	});

	it("restores the session model ahead of a different saved default", async () => {
		const modelRuntime = await cachedRuntime();
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange(LLAMA_PROVIDER_ID, "previous-model");
		sessionManager.appendMessage(userMsg("previous prompt"));
		const { session, modelFallbackMessage } = await createSessionFromServices({
			services: {
				cwd: process.cwd(),
				agentDir: process.cwd(),
				modelRuntime,
				settingsManager: SettingsManager.inMemory({
					defaultProvider: LLAMA_PROVIDER_ID,
					defaultModel: "saved-default",
					contextBudget: "full",
				}),
				resourceLoader: createTestResourceLoader(),
				diagnostics: [],
			},
			sessionManager,
			noTools: "all",
		});
		try {
			expect(modelFallbackMessage).toBeUndefined();
			expect(session.model).toMatchObject({ provider: LLAMA_PROVIDER_ID, id: "previous-model", contextWindow: 8192 });
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			session.dispose();
			modelRuntime.dispose();
		}
	});
});
