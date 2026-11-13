import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, Provider } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionFromServices } from "../src/core/agent-session/create-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { findInitialModel } from "../src/core/model-resolver.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader, userMsg } from "./utilities.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixtureProvider(id: string): Provider<"openai-completions"> {
	const model: Model<"openai-completions"> = {
		id: "model",
		name: id,
		provider: id,
		api: "openai-completions",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
	};
	return {
		id,
		name: id,
		auth: {
			apiKey: {
				name: "API key",
				login: async () => ({ type: "api_key", key: "fixture" }),
				check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
				resolve: async () => ({ auth: { apiKey: "fixture" }, source: "stored" }),
			},
		},
		getModels: () => [model],
		stream: () => {
			throw new Error("No inference expected");
		},
		streamSimple: () => {
			throw new Error("No inference expected");
		},
	};
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "octocode-selection-availability-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory({
			alpha: { type: "api_key", key: "fixture-a" },
			beta: { type: "api_key", key: "fixture-b" },
		}),
		modelsPath: null,
		allowModelNetwork: false,
	});
	cleanups.push(() => runtime.dispose());
	for (const id of ["alpha", "beta"]) runtime.registerNativeProvider(fixtureProvider(id));
	await runtime.refresh({ allowNetwork: false, providers: ["alpha", "beta"] });
	await runtime.getAvailable();
	return { root, runtime };
}

describe("saved model availability", () => {
	it("does not resurrect a disabled default provider that still has stored credentials", async () => {
		const { runtime } = await fixture();
		runtime.setDisabledProviders(["alpha"]);
		expect(runtime.hasConfiguredAuth("alpha")).toBe(true);
		expect(runtime.getModel("alpha", "model")).toBeDefined();
		const { model } = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "alpha",
			defaultModelId: "model",
			modelRuntime: runtime,
		});
		expect(model?.provider).toBe("beta");
	});

	it.each([true, false])(
		"restores a previous session only while its provider is available (disabled=%s)",
		async (disabled) => {
			const { root, runtime } = await fixture();
			if (disabled) runtime.setDisabledProviders(["alpha"]);
			const sessionManager = SessionManager.inMemory(root);
			sessionManager.appendModelChange("alpha", "model");
			sessionManager.appendMessage(userMsg("previous prompt"));
			const { session, modelFallbackMessage } = await createSessionFromServices({
				services: {
					cwd: root,
					agentDir: root,
					modelRuntime: runtime,
					settingsManager: SettingsManager.inMemory({ defaultProvider: "beta", defaultModel: "model" }),
					resourceLoader: createTestResourceLoader(),
					diagnostics: [],
				},
				sessionManager,
				noTools: "all",
			});
			cleanups.push(() => session.dispose());
			expect(session.model?.provider).toBe(disabled ? "beta" : "alpha");
			if (disabled) expect(modelFallbackMessage).toContain("Could not restore model alpha/model");
			else expect(modelFallbackMessage).toBeUndefined();
		},
	);
});
