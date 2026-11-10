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
	it("reads a stored key that is a Claude subscription token as subscription", async () => {
		const runtime = await runtimeWith({ anthropic: { type: "api_key", key: "sk-ant-oat01-test" } });
		expect(await runtime.getCredentialKind("anthropic")).toBe("subscription");
	});

	it("resolves a command reference the way a request does, and reads its result", async () => {
		const runtime = await runtimeWith({ anthropic: { type: "api_key", key: "!printf sk-ant-oat01-test" } });
		expect(await runtime.getCredentialKind("anthropic")).toBe("subscription");
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
