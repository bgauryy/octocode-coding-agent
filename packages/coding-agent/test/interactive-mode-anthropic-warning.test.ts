import { describe, expect, test, vi } from "vitest";
import * as modelControls from "../src/modes/interactive/interactive-mode/model-controls.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function createSettingsManager(warnings: { anthropicExtraUsage?: boolean } = {}) {
	return {
		getWarnings: vi.fn().mockReturnValue(warnings),
	};
}

function createModelRuntime(credential: { type: "oauth" } | undefined, apiKey?: string) {
	return {
		checkAuth: vi.fn().mockResolvedValue(credential),
		getAuth: vi.fn().mockResolvedValue(apiKey ? { auth: { apiKey } } : undefined),
	};
}

function maybeWarnAboutAnthropicSubscriptionAuth(host: object, model: { provider: string }): Promise<void> {
	return modelControls.maybeWarnAboutAnthropicSubscriptionAuth(host as never, model as never);
}

describe("InteractiveMode.maybeWarnAboutAnthropicSubscriptionAuth", () => {
	test("warns once when Anthropic subscription auth is detected", async () => {
		const modelRuntime = createModelRuntime(undefined, "sk-ant-oat01-test");
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
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
		expect(modelRuntime.getAuth).toHaveBeenCalledTimes(1);
	});

	test("warns when Anthropic OAuth is stored even if token refresh lookup would fail", async () => {
		const modelRuntime = createModelRuntime({ type: "oauth" });
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager(),
			session: { modelRuntime },
			showWarning: vi.fn(),
		};

		await maybeWarnAboutAnthropicSubscriptionAuth(createFakeHost(fakeThis), {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledTimes(1);
		expect(modelRuntime.getAuth).not.toHaveBeenCalled();
	});

	test("does not warn for non-Anthropic models", async () => {
		const modelRuntime = createModelRuntime(undefined);
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
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
		const modelRuntime = createModelRuntime(undefined);
		const fakeThis: any = {
			anthropicSubscriptionWarningShown: false,
			settingsManager: createSettingsManager({ anthropicExtraUsage: false }),
			session: { modelRuntime },
			showWarning: vi.fn(),
		};

		await maybeWarnAboutAnthropicSubscriptionAuth(createFakeHost(fakeThis), {
			provider: "anthropic",
		});

		expect(fakeThis.showWarning).not.toHaveBeenCalled();
		expect(modelRuntime.checkAuth).not.toHaveBeenCalled();
		expect(modelRuntime.getAuth).not.toHaveBeenCalled();
	});
});
