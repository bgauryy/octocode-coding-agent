import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinModels } from "@octocodeai/octocode-ai/providers/all";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ownProviderDefault } from "../src/core/model-resolver/default-models.ts";
import { normalizeModelId } from "../src/core/provider-composer/known-models.ts";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

/** A gateway entry that names a vendor's model by id gets that model's metadata; the fields it sets win. */
let dir: string;
let modelsPath: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "octocode-known-models-"));
	modelsPath = join(dir, "models.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const builtin = (provider: string, id: string) => {
	const model = (getBuiltinModels(provider as never) as { id: string }[]).find((entry) => entry.id === id);
	if (!model) throw new Error(`no built-in ${provider}/${id}`);
	return model as ReturnType<typeof getBuiltinModels>[number];
};

async function registryFor(providers: Record<string, unknown>) {
	writeFileSync(modelsPath, JSON.stringify({ providers }));
	const registry = await createModelRegistry(AuthStorage.inMemory(), modelsPath);
	expect(registry.getError()).toBeUndefined();
	return registry;
}

describe("models.json entries that name a known model", () => {
	test("inherits Bedrock catalog limits, regional prices and effort on its OpenAI-compatible endpoint", async () => {
		const id = "global.moonshotai.kimi-k3.1";
		const registry = await registryFor({
			"custom-bedrock": {
				baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1",
				api: "openai-completions",
				apiKey: "fixture",
				models: [{ id }, { id: "in.moonshotai.kimi-k3.1", maxTokens: 4096 }],
			},
			"other-host": {
				baseUrl: "https://example.test/bedrock-runtime.us-east-1.amazonaws.com",
				api: "openai-completions",
				apiKey: "fixture",
				models: [{ id }],
			},
		});
		expect(registry.find("custom-bedrock", id)).toMatchObject({
			maxTokens: 131072,
			cost: { cacheRead: 0.2, cacheWrite: 5 },
			thinkingLevelMap: { off: "none", minimal: null },
		});
		expect(registry.find("custom-bedrock", "in.moonshotai.kimi-k3.1")).toMatchObject({
			id: "in.moonshotai.kimi-k3.1",
			maxTokens: 4096,
			cost: { cacheRead: 0.22, cacheWrite: 5.5 },
			thinkingLevelMap: { off: "none", minimal: null },
		});
		expect(registry.find("other-host", id)?.maxTokens).toBe(16384);
	});

	test("a gateway provider's bare ids take each vendor's model metadata", async () => {
		const registry = await registryFor({
			"anthropic-gw": {
				baseUrl: "https://gateway.test/anthropic",
				api: "anthropic-messages",
				apiKey: "k",
				models: [{ id: "claude-opus-5-5" }],
			},
			"openai-gw": {
				baseUrl: "https://gateway.test/openai/v1",
				api: "openai-responses",
				apiKey: "k",
				models: [{ id: "gpt-6.1-sol" }],
			},
			"google-gw": {
				baseUrl: "https://gateway.test/google",
				api: "google-generative-ai",
				apiKey: "k",
				models: [{ id: "gemini-3.8-flash" }],
			},
		});
		for (const [gateway, vendor, id] of [
			["anthropic-gw", "anthropic", "claude-opus-5-5"],
			["openai-gw", "openai", "gpt-6.1-sol"],
			["google-gw", "google", "gemini-3.8-flash"],
		] as const) {
			const model = registry.find(gateway, id)!;
			const known = builtin(vendor, id);
			expect(model).toMatchObject({
				provider: gateway,
				name: known.name,
				reasoning: known.reasoning,
				input: known.input,
				contextWindow: known.contextWindow,
				maxTokens: known.maxTokens,
				cost: known.cost,
			});
			expect(model.thinkingLevelMap).toEqual(known.thinkingLevelMap);
			expect(model.baseUrl).toMatch(/^https:\/\/gateway\.test\//);
		}
	});

	test("the entry's own fields win, compat merges over the known model's", async () => {
		const registry = await registryFor({
			gw: {
				baseUrl: "https://gateway.test/anthropic",
				api: "anthropic-messages",
				apiKey: "k",
				models: [
					{ id: "claude-sonnet-5-5", contextWindow: 200000, input: ["text"], compat: { supportsStrictTools: false } },
				],
			},
		});
		const model = registry.find("gw", "claude-sonnet-5-5")!;
		expect(model.contextWindow).toBe(200000);
		expect(model.input).toEqual(["text"]);
		expect(model.maxTokens).toBe(builtin("anthropic", "claude-sonnet-5-5").maxTokens);
		expect(model.compat).toMatchObject({ supportsStrictTools: false, forceAdaptiveThinking: true });
	});

	test("direct-provider cache claims do not carry to another host unless the entry declares them", async () => {
		const registry = await registryFor({
			gw: {
				baseUrl: "https://gateway.test/anthropic",
				api: "anthropic-messages",
				apiKey: "k",
				models: [
					{ id: "claude-opus-5-5" },
					{
						id: "claude-haiku-5-5",
						promptCache: { short: 300, long: 3600 },
						compat: { supportsLongCacheRetention: true },
					},
				],
			},
		});
		const plain = registry.find("gw", "claude-opus-5-5")!;
		expect(plain.promptCache).toBeUndefined();
		expect(plain.compat).toMatchObject({ supportsLongCacheRetention: false });
		const declared = registry.find("gw", "claude-haiku-5-5")!;
		expect(declared.promptCache).toEqual({ short: 300, long: 3600 });
		expect(declared.compat).toMatchObject({ supportsLongCacheRetention: true });
	});

	test("ids match across a vendor prefix and dot or dash; an unknown id keeps the plain defaults", async () => {
		const registry = await registryFor({
			gw: {
				baseUrl: "https://gateway.test/v1",
				api: "anthropic-messages",
				apiKey: "k",
				models: [{ id: "anthropic/claude-opus-5.5" }, { id: "claude-unreleased-9" }],
			},
		});
		expect(registry.find("gw", "anthropic/claude-opus-5.5")?.maxTokens).toBe(
			builtin("anthropic", "claude-opus-5-5").maxTokens,
		);
		expect(registry.find("gw", "claude-unreleased-9")).toMatchObject({
			contextWindow: 128000,
			maxTokens: 16384,
			reasoning: false,
			input: ["text"],
		});
	});

	test("a model on another API (a LiteLLM-style openai-completions gateway) takes only API-independent fields", async () => {
		const registry = await registryFor({
			litellm: {
				baseUrl: "http://localhost:4000",
				api: "openai-completions",
				apiKey: "k",
				models: [{ id: "claude-sonnet-5-5" }, { id: "openai/gpt-6.1-sol" }],
			},
		});
		for (const [vendor, id, entry] of [
			["anthropic", "claude-sonnet-5-5", "claude-sonnet-5-5"],
			["openai", "gpt-6.1-sol", "openai/gpt-6.1-sol"],
		] as const) {
			const known = builtin(vendor, id);
			const model = registry.find("litellm", entry)!;
			expect(model).toMatchObject({
				api: "openai-completions",
				contextWindow: known.contextWindow,
				maxTokens: known.maxTokens,
				reasoning: known.reasoning,
				input: known.input,
				cost: known.cost,
			});
			// The vendor's own request settings, thinking map and cache lifetimes stay with its API.
			expect(model.thinkingLevelMap).toBeUndefined();
			expect(model.promptCache).toBeUndefined();
			expect(model.compat as Record<string, unknown> | undefined).not.toHaveProperty("forceAdaptiveThinking");
			expect(model.compat as Record<string, unknown> | undefined).not.toHaveProperty("supportsToolSearch");
		}
	});

	test("a modelOverrides entry on an official provider layers limits over the built-in model", async () => {
		const registry = await registryFor({
			anthropic: { modelOverrides: { "claude-opus-5-5": { contextWindow: 500000 } } },
		});
		const model = registry.find("anthropic", "claude-opus-5-5")!;
		const known = builtin("anthropic", "claude-opus-5-5");
		expect(model.contextWindow).toBe(500000);
		expect(model).toMatchObject({
			reasoning: true,
			maxTokens: known.maxTokens,
			cost: known.cost,
			promptCache: known.promptCache,
		});
	});
});

describe("a gateway as the default provider", () => {
	const model = (provider: string, id: string) => ({ provider, id }) as never;
	test("uses its model that a vendor defaults to, else its first, never another provider's", () => {
		const available = [model("other", "x"), model("gw", "claude-haiku-5-5"), model("gw", "anthropic/claude-opus-5.5")];
		expect(ownProviderDefault(available, "gw")).toMatchObject({ id: "anthropic/claude-opus-5.5" });
		expect(ownProviderDefault([model("other", "x"), model("gw", "a"), model("gw", "b")], "gw")).toMatchObject({
			id: "a",
		});
		expect(ownProviderDefault([model("other", "x")], "gw")).toBeUndefined();
		expect(normalizeModelId("Anthropic/Claude-Opus-5.5")).toBe("claude-opus-5-5");
	});
});

describe("a models.json that does not parse", () => {
	test("names the file and the location, never the text around the error", async () => {
		writeFileSync(modelsPath, '{ "providers": { "gw": { "apiKey": sk-SECRET-VALUE } } }');
		const registry = await createModelRegistry(AuthStorage.inMemory(), modelsPath);
		const error = registry.getError() ?? "";
		expect(error).toContain("Failed to parse models.json");
		expect(error).toContain(modelsPath);
		expect(error).not.toContain("SECRET");
		writeFileSync(modelsPath, '{ "providers": { "gw": { "apiKey": "sk-SECRET-VALUE" "x": 1 } } }');
		const located = (await createModelRegistry(AuthStorage.inMemory(), modelsPath)).getError() ?? "";
		expect(located).toMatch(/invalid JSON at line 1, column \d+/);
		expect(located).not.toContain("SECRET");
	});
});
