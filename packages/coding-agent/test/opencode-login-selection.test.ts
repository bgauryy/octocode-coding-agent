import { describe, expect, it, vi } from "vitest";
import { getBuiltinModels } from "@octocodeai/octocode-ai/providers/all";
import { completeProviderAuthentication } from "../src/modes/interactive/interactive-mode/login-dialogs.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { findExactModelReferenceMatch } from "../src/core/model-resolver.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

describe.each(["anthropic", "openai", "google", "opencode", "opencode-go"] as const)(
	"%s login model selection",
	(provider) => {
		it.each(["another-provider", "unknown"])(
			"opens the model picker while keeping %s selected",
			async (previousProvider) => {
				const models = getBuiltinModels(provider);
				expect(models.length).toBeGreaterThan(0);
				const previous = {
					...models[0],
					provider: previousProvider,
					...(previousProvider === "unknown" ? { id: "unknown" } : {}),
				};
				const showModelSelector = vi.fn();
				const context = {
					session: {
						model: previous,
						modelRuntime: {
							getAvailableSnapshot: () => models,
							getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
							refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
						},
					},
					showModelSelector,
					showStatus: vi.fn(),
					showError: vi.fn(),
					showWarning: vi.fn(),
					updateAvailableProviderCount: vi.fn(),
					updateEditorBorderColor: vi.fn(),
					maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
					ui: { requestRender: vi.fn() },
				};
				await completeProviderAuthentication(createFakeHost(context), provider, provider, "api_key");
				expect(showModelSelector).toHaveBeenCalledExactlyOnceWith(`${provider}/`);
				expect(context.session.model).toBe(previous);
				expect(context.showError).not.toHaveBeenCalled();
			},
		);
	},
);

describe.each(["opencode", "opencode-go"] as const)("%s runtime login", (provider) => {
	it("makes the authenticated catalog selectable by a qualified model name", async () => {
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		const prompt = vi.fn(async () => "test-opencode-key");
		await runtime.login(provider, "api_key", { prompt, notify: () => {} });
		expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ type: "secret" }));
		expect(await credentials.read(provider)).toMatchObject({ type: "api_key", key: "test-opencode-key" });
		const available = runtime.getAvailableSnapshot();
		const models = available.filter((model) => model.provider === provider);
		expect(models.length).toBeGreaterThan(0);
		for (const model of models) {
			expect(findExactModelReferenceMatch(`${provider}/${model.id}`, available)).toBe(model);
			expect(model.baseUrl).toContain("https://opencode.ai/inference/");
		}
	});
});
