import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { resolveCliModel } from "../src/core/model-resolver.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

/** The built-in catalog, with only `configured` providers holding credentials (the developer's environment never counts). */
async function runtimeWith(configured: readonly string[]) {
	const runtime = getModelRuntime(await createInMemoryModelRegistry(AuthStorage.inMemory()));
	vi.spyOn(runtime, "hasConfiguredAuth").mockImplementation((provider) => configured.includes(provider));
	return runtime;
}

describe("--model with a bare name offered by several providers", () => {
	afterEach(() => vi.restoreAllMocks());

	test("with no credentials it reports the ambiguity instead of picking a provider by id order", async () => {
		const result = resolveCliModel({ cliModel: "sonnet", modelRuntime: await runtimeWith([]) });

		expect(result.model).toBeUndefined();
		expect(result.error).toMatch(/^Model "sonnet" is ambiguous across providers: /);
		expect(result.error).toContain("anthropic/claude-sonnet-");
		expect(result.error).toContain("amazon-bedrock/");
		expect(result.error).toContain("No matching provider is authenticated. Use --provider or provider/model.");
	});

	test("an inline --api-key does not choose the provider either", async () => {
		const result = resolveCliModel({ cliModel: "sonnet", inlineApiKey: true, modelRuntime: await runtimeWith([]) });

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("--api-key does not choose a provider.");
	});

	test("one provider with credentials still resolves to it", async () => {
		const result = resolveCliModel({ cliModel: "sonnet", modelRuntime: await runtimeWith(["anthropic"]) });

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toMatch(/^claude-sonnet-/);
	});
});
