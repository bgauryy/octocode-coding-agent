import { describe, expect, test, vi } from "vitest";
import { CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL } from "@octocodeai/octocode-ai/api/anthropic-messages/token";
import * as modelControls from "../src/modes/interactive/interactive-mode/model-controls.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function createSettingsManager(warnings: { anthropicExtraUsage?: boolean } = {}) {
	return {
		getWarnings: vi.fn().mockReturnValue(warnings),
	};
}

/** A runtime whose Anthropic credential resolves to `auth`, the way a request would resolve it. */
function createModelRuntime(auth: { apiKey?: string; headers?: Record<string, string> } | undefined) {
	return {
		getAuth: vi.fn().mockResolvedValue(auth ? { auth } : undefined),
	};
}

const SUBSCRIPTION = { apiKey: "sk-ant-oat01-test" };

function maybeWarnAboutAnthropicSubscriptionAuth(host: object, model: { provider: string }): Promise<void> {
	return modelControls.maybeWarnAboutAnthropicSubscriptionAuth(host as never, model as never);
}

describe("InteractiveMode.maybeWarnAboutAnthropicSubscriptionAuth", () => {
	test("names the external agent once when a saved Claude subscription token is found", async () => {
		const modelRuntime = createModelRuntime(SUBSCRIPTION);
		const fakeThis: any = {
			uiStore: createUiStore(),
			settingsManager: createSettingsManager(),
			session: { modelRuntime },
			showWarning: vi.fn(),
		};

		await maybeWarnAboutAnthropicSubscriptionAuth(createFakeHost(fakeThis), {
			provider: "anthropic",
		});
		await maybeWarnAboutAnthropicSubscriptionAuth(createFakeHost(fakeThis), {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(fakeThis.showWarning).toHaveBeenCalledWith(CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL);
		expect(fakeThis.showWarning.mock.calls[0][0]).not.toContain("sk-ant-oat01-test");
		expect(modelRuntime.getAuth).toHaveBeenCalledTimes(1);
	});

	test("at startup reads the saved Anthropic credential although no Anthropic model is selected", async () => {
		// The token configures nothing, so the initial model is never Anthropic; the notice still says why once.
		const modelRuntime = createModelRuntime(SUBSCRIPTION);
		const fakeThis: any = {
			uiStore: createUiStore(),
			settingsManager: createSettingsManager(),
			session: { modelRuntime, model: { provider: "openai", id: "gpt" } },
			showWarning: vi.fn(),
		};

		await modelControls.maybeWarnAboutAnthropicSubscriptionAuth(createFakeHost(fakeThis));

		expect(modelRuntime.getAuth).toHaveBeenCalledWith("anthropic");
		expect(fakeThis.showWarning).toHaveBeenCalledWith(CLAUDE_SUBSCRIPTION_TOKEN_REFUSAL);
	});

	test("warns for a subscription token sent as a bearer Authorization header", async () => {
		const modelRuntime = createModelRuntime({ headers: { Authorization: "Bearer sk-ant-oat01-test" } });
		const fakeThis: any = {
			uiStore: createUiStore(),
			settingsManager: createSettingsManager(),
			session: { modelRuntime },
			showWarning: vi.fn(),
		};

		await maybeWarnAboutAnthropicSubscriptionAuth(createFakeHost(fakeThis), {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
	});

	test("does not warn for an API key, a gateway token or no credential", async () => {
		for (const auth of [
			{ apiKey: "sk-ant-api03-test" },
			{ headers: { Authorization: "Bearer gateway-token" } },
			undefined,
		]) {
			const fakeThis: any = {
				uiStore: createUiStore(),
				settingsManager: createSettingsManager(),
				session: { modelRuntime: createModelRuntime(auth) },
				showWarning: vi.fn(),
			};
			await maybeWarnAboutAnthropicSubscriptionAuth(createFakeHost(fakeThis), { provider: "anthropic" });
			expect(fakeThis.showWarning).not.toHaveBeenCalled();
		}
	});

	test("does not warn for non-Anthropic models", async () => {
		const modelRuntime = createModelRuntime({ apiKey: "sk-ant-api03-test" });
		const fakeThis: any = {
			uiStore: createUiStore(),
			settingsManager: createSettingsManager(),
			session: { modelRuntime },
			showWarning: vi.fn(),
		};

		await maybeWarnAboutAnthropicSubscriptionAuth(createFakeHost(fakeThis), {
			provider: "openai",
		});

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(modelRuntime.getAuth).not.toHaveBeenCalled();
	});

	test("does not warn when Anthropic extra usage warning is disabled", async () => {
		const modelRuntime = createModelRuntime({ apiKey: "sk-ant-api03-test" });
		const fakeThis: any = {
			uiStore: createUiStore(),
			settingsManager: createSettingsManager({ anthropicExtraUsage: false }),
			session: { modelRuntime },
			showWarning: vi.fn(),
		};

		await maybeWarnAboutAnthropicSubscriptionAuth(createFakeHost(fakeThis), {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(modelRuntime.getAuth).not.toHaveBeenCalled();
	});
});
