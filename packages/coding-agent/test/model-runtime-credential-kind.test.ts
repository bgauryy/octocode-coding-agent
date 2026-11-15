import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

async function runtimeWith(credentials: Parameters<typeof AuthStorage.inMemory>[0]): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(credentials),
		modelsPath: null,
		allowModelNetwork: false,
	});
	await runtime.refresh({ allowNetwork: false });
	await runtime.getAvailable();
	return runtime;
}

describe("credential kind", () => {
	it("reads a stored Claude subscription token as key: Anthropic has no plan credential of its own", async () => {
		// Requests refuse the token and name the Claude Code external agent; it is not a subscription route.
		const runtime = await runtimeWith({ anthropic: { type: "api_key", key: "sk-ant-oat01-test" } });
		expect(await runtime.getCredentialKind("anthropic")).toBe("key");
	});

	it("reads a plain key as key", async () => {
		const runtime = await runtimeWith({ anthropic: { type: "api_key", key: "sk-ant-api03-test" } });
		expect(await runtime.getCredentialKind("anthropic")).toBe("key");
	});

	it("reads a key of a provider with no subscription token form as key", async () => {
		const runtime = await runtimeWith({ openai: { type: "api_key", key: "sk-ant-oat01-test" } });
		expect(await runtime.getCredentialKind("openai")).toBe("key");
	});

	it("reads an unconfigured provider as key", async () => {
		expect(await (await runtimeWith({})).getCredentialKind("anthropic")).toBe("key");
	});
});

describe("a saved Claude subscription token", () => {
	it("configures nothing: no model of the provider is available, and the request path still sees the token", async () => {
		// Every request refuses the token, so offering its models would only route work to a provider that fails.
		const runtime = await runtimeWith({
			anthropic: { type: "api_key", key: "sk-ant-oat01-test" },
			openai: { type: "api_key", key: "sk-test" },
		});
		expect(runtime.hasConfiguredAuth("anthropic")).toBe(false);
		expect(runtime.getProviderAuthStatus("anthropic")).toEqual({
			configured: false,
			source: "stored",
			label: "auth.json",
		});
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "anthropic")).toBe(false);
		expect(runtime.getAvailableSnapshot().some((model) => model.provider === "openai")).toBe(true);
		expect((await runtime.getAuth("anthropic"))?.auth.apiKey).toBe("sk-ant-oat01-test");
	});
});
