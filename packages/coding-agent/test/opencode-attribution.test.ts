import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { describe, expect, it } from "vitest";
import { mergeProviderAttributionHeaders } from "../src/core/provider-attribution.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("OpenCode operational headers", () => {
	const settings = SettingsManager.inMemory({ enableInstallTelemetry: false });
	const model = {
		...getBuiltinModel("openai", "gpt-6.1-sol"),
		provider: "opencode",
		baseUrl: "https://opencode.ai/inference/openai/v1",
	};
	it("identifies Octocode and keeps conversation routing with telemetry disabled", () => {
		const headers = mergeProviderAttributionHeaders(model, settings, "conversation");
		expect(headers?.["User-Agent"]).toMatch(/^octocode\//);
		expect(headers?.["x-opencode-session"]).toBe("conversation");
		expect(headers?.["x-opencode-client"]).toBe("octocode");
	});
	it("does not invent a conversation ID and preserves explicit header overrides", () => {
		expect(mergeProviderAttributionHeaders(model, settings, undefined)?.["x-opencode-session"]).toBeUndefined();
		expect(
			mergeProviderAttributionHeaders(model, settings, "session", {
				"User-Agent": "custom",
				"x-opencode-session": "custom-session",
			}),
		).toMatchObject({ "User-Agent": "custom", "x-opencode-session": "custom-session" });
	});
});
