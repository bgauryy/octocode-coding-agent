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

describe("request agent headers", () => {
	const settings = SettingsManager.inMemory({ enableInstallTelemetry: false });
	const custom = {
		...getBuiltinModel("openai", "gpt-6.1-sol"),
		provider: "my-gateway",
		baseUrl: "http://localhost:9/v1",
	};
	const vendor = getBuiltinModel("openai", "gpt-6.1-sol");
	const child = {
		OCTOCODE_REQUEST_AGENT_HEADERS: "1",
		OCTOCODE_AGENT_ID: "zesty-kelp",
		OCTOCODE_AGENT_ROLE: "implementer",
		OCTOCODE_PARENT_ID: "salty-kelp",
	};
	const withEnv = <T>(env: Record<string, string>, run: () => T): T => {
		const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
		Object.assign(process.env, env);
		try {
			return run();
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	};
	it("labels a custom provider's request with the child, its role and its parent", () => {
		expect(withEnv(child, () => mergeProviderAttributionHeaders(custom, settings, "s"))).toEqual({
			"x-octocode-agent": "zesty-kelp",
			"x-octocode-role": "implementer",
			"x-octocode-parent": "salty-kelp",
		});
	});
	it("labels the session itself main", () => {
		const env = {
			OCTOCODE_REQUEST_AGENT_HEADERS: "1",
			OCTOCODE_AGENT_ID: "",
			OCTOCODE_PARENT_ID: "",
			OCTOCODE_AGENT_ROLE: "",
		};
		expect(withEnv(env, () => mergeProviderAttributionHeaders(custom, settings, "s"))).toEqual({
			"x-octocode-agent": "main",
		});
	});
	it("sends nothing unless opted in, and never to a built-in vendor", () => {
		expect(mergeProviderAttributionHeaders(custom, settings, "s")).toBeUndefined();
		expect(withEnv(child, () => mergeProviderAttributionHeaders(vendor, settings, "s"))).toBeUndefined();
	});
});
