import { describe, expect, test, vi } from "vitest";
import * as modelControls from "../src/modes/interactive/interactive-mode/model-controls.ts";
import { createFakeHost } from "./interactive-mode-host.ts";

function createSettingsManager(warnings: { anthropicExtraUsage?: boolean } = {}) {
	return {
		getWarnings: vi.fn().mockReturnValue(warnings),
	};
}

function createModelRuntime(kind: "account" | "subscription" | "key") {
	return {
		getCredentialKind: vi.fn().mockResolvedValue(kind),
	};
}

function maybeWarnAboutAnthropicSubscriptionAuth(host: object, model: { provider: string }): Promise<void> {
	return modelControls.maybeWarnAboutAnthropicSubscriptionAuth(host as never, model as never);
}

describe("InteractiveMode.maybeWarnAboutAnthropicSubscriptionAuth", () => {
	test("warns once when Anthropic subscription auth is detected", async () => {
		const modelRuntime = createModelRuntime("subscription");
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
		expect(modelRuntime.getCredentialKind).toHaveBeenCalledTimes(1);
	});

	test("warns when the credential is a stored subscription login", async () => {
		const modelRuntime = createModelRuntime("subscription");
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
	});

	test("does not warn for an API key or a plain account", async () => {
		for (const kind of ["key", "account"] as const) {
			const fakeThis: any = {
				anthropicSubscriptionWarningShown: false,
				settingsManager: createSettingsManager(),
				session: { modelRuntime: createModelRuntime(kind) },
				showWarning: vi.fn(),
			};
			await maybeWarnAboutAnthropicSubscriptionAuth(createFakeHost(fakeThis), { provider: "anthropic" });
			expect(fakeThis.showWarning).not.toHaveBeenCalled();
		}
	});

	test("does not warn for non-Anthropic models", async () => {
		const modelRuntime = createModelRuntime("key");
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
		expect(modelRuntime.getCredentialKind).not.toHaveBeenCalled();
	});

	test("does not warn when Anthropic extra usage warning is disabled", async () => {
		const modelRuntime = createModelRuntime("key");
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
		expect(modelRuntime.getCredentialKind).not.toHaveBeenCalled();
	});
});
