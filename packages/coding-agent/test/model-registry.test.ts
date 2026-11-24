/* oxlint-disable typescript/no-unnecessary-type-assertion -- tsc needs these casts to narrow the compat union */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext } from "@octocodeai/octocode-ai";
import type { AnthropicMessagesCompat, Api, Model, OpenAICompletionsCompat } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModels } from "@octocodeai/octocode-ai/providers/all";
import { getApiProvider, getSupportedThinkingLevels, streamSimple } from "@octocodeai/octocode-ai/compat";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ModelRegistry, ProviderConfigInput } from "../src/core/model-registry.ts";
import { clearConfigValueCache } from "@octocodeai/octocode-ai/utils/resolve-config-value";
import { createModelRegistry } from "./model-runtime-test-utils.ts";

describe("ModelRegistry", () => {
	let tempDir: string;
	let modelsJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `octocode-test-model-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		modelsJsonPath = join(tempDir, "models.json");
		authStorage = AuthStorage.inMemory();
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	/** Create minimal provider config  */
	function providerConfig(
		baseUrl: string,
		models: Array<{ id: string; name?: string }>,
		api: string = "anthropic-messages",
	): ProviderConfigInput {
		return {
			baseUrl,
			apiKey: "test-key",
			api: api,
			models: models.map((m) => ({
				id: m.id,
				name: m.name ?? m.id,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100000,
				maxTokens: 8000,
			})),
		};
	}

	function getModelsForProvider(registry: ModelRegistry, provider: string) {
		return registry.getAll().filter((m) => m.provider === provider);
	}

	function toShPath(value: string): string {
		return value.replace(/\\/g, "/").replace(/"/g, '\\"');
	}

	/** Write raw providers config (for mixed override/replacement scenarios) */
	function writeRawModelsJson(providers: Record<string, unknown>) {
		writeFileSync(modelsJsonPath, JSON.stringify({ providers }));
	}

	const openAiModel: Model<Api> = {
		id: "test-openai-model",
		name: "Test OpenAI Model",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};

	const emptyContext = normalizeContext({
		messages: [],
	});

	describe("compatibility auth", () => {
		test("unconfigured compatibility auth includes static model headers", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const base = registry.getAll()[0];
			const model = {
				...base,
				provider: "missing-provider",
				headers: { "X-Static-Model": "static-value" },
			};

			const auth = await registry.getApiKeyAndHeaders(model);

			expect(auth).toEqual({ ok: true, headers: { "X-Static-Model": "static-value" } });
		});
	});

	describe("custom models merge behavior", () => {
		test("non-built-in provider custom models still require baseUrl", async () => {
			writeRawModelsJson({
				"my-custom-provider": {
					apiKey: "test-key",
					models: [
						{
							id: "my-model",
							api: "openai-completions",
							reasoning: false,
							input: ["text"],
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			expect(registry.getError()).toContain("baseUrl");
		});

		test("reports every provider composition error", async () => {
			writeRawModelsJson({
				"broken-one": { api: "openai-completions", models: [{ id: "one" }] },
				"broken-two": { api: "openai-completions", models: [{ id: "two" }] },
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const error = registry.getError();

			expect(error).toContain('Provider "broken-one"');
			expect(error).toContain('Provider "broken-two"');
		});

		test("provider-level compat applies to custom models", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(false);
			expect(compat?.maxTokensField).toBe("max_tokens");
		});

		test("model-level compat overrides provider-level compat for custom models", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					compat: {
						supportsUsageInStreaming: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								supportsUsageInStreaming: true,
								maxTokensField: "max_completion_tokens",
							},
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(compat?.supportsUsageInStreaming).toBe(true);
			expect(compat?.maxTokensField).toBe("max_completion_tokens");
		});

		test("resolves the tool dialect per model on a shared Chat Completions endpoint", async () => {
			const baseUrl = "https://gateway.example/v1";
			writeRawModelsJson({
				gateway: {
					api: "openai-completions",
					baseUrl,
					apiKey: "fixture",
					compat: { toolSchemaFlavor: "moonshot" },
					models: [{ id: "opaque-deployment" }, { id: "kimi-alias", compat: { toolSchemaFlavor: "standard" } }],
				},
			});
			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const parameters = { type: "object", properties: { choice: { const: "text" } } };
			for (const [id, expected] of [
				["opaque-deployment", { type: "string", enum: ["text"] }],
				["kimi-alias", { const: "text" }],
			] as const) {
				const model = registry.find("gateway", id)!;
				expect(model).toMatchObject({ provider: "gateway", id, baseUrl, api: "openai-completions" });
				let wire: unknown;
				const result = await streamSimple(
					model,
					{
						messages: [{ role: "user", content: "Check", timestamp: 0 }],
						tools: [{ name: "select", description: "Choose", parameters }],
					},
					{
						apiKey: "fixture",
						fetch: async () => {
							throw new Error("Unexpected network request");
						},
						onPayload: (payload) => {
							wire = payload;
							throw new Error("Captured");
						},
					},
				).result();
				expect(result.errorMessage).toBe("Captured");
				expect(wire).toMatchObject({
					model: id,
					tools: [{ function: { parameters: { properties: { choice: expected } } } }],
				});
			}
		});

		test("model schema accepts thinkingLevelMap and compat schema accepts supportsStrictMode and cacheControlFormat", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							thinkingLevelMap: {
								minimal: null,
								high: "max",
							},
							compat: {
								supportsStrictMode: false,
								cacheControlFormat: "anthropic",
							},
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("demo", "demo-model");
			const compat = model?.compat as OpenAICompletionsCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(model?.thinkingLevelMap).toEqual({ minimal: null, high: "max" });
			expect(compat?.supportsStrictMode).toBe(false);
			expect(compat?.cacheControlFormat).toBe("anthropic");
		});

		test("compat schema accepts chat template thinking configuration", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com/v1",
					apiKey: "DEMO_KEY",
					api: "openai-completions",
					models: [
						{
							id: "kwargs-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								thinkingFormat: "chat-template",
								chatTemplateKwargs: {
									preserve_thinking: true,
									thinking: { $var: "thinking.enabled" },
								},
							},
						},
						{
							id: "args-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
							compat: {
								thinkingFormat: "baseten",
								chatTemplateArgs: {
									enable_thinking: { $var: "thinking.enabled" },
								},
							},
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const kwargsCompat = registry.find("demo", "kwargs-model")?.compat as OpenAICompletionsCompat | undefined;
			const argsCompat = registry.find("demo", "args-model")?.compat as OpenAICompletionsCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(kwargsCompat?.thinkingFormat).toBe("chat-template");
			expect(kwargsCompat?.chatTemplateKwargs).toEqual({
				preserve_thinking: true,
				thinking: { $var: "thinking.enabled" },
			});
			expect(argsCompat?.thinkingFormat).toBe("baseten");
			expect(argsCompat?.chatTemplateArgs).toEqual({
				enable_thinking: { $var: "thinking.enabled" },
			});
		});

		test("compat schema accepts Anthropic eager tool input streaming flag", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com",
					apiKey: "DEMO_KEY",
					api: "anthropic-messages",
					compat: {
						supportsEagerToolInputStreaming: false,
					},
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as AnthropicMessagesCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(compat?.supportsEagerToolInputStreaming).toBe(false);
		});

		test("compat schema accepts long cache retention flag", async () => {
			writeRawModelsJson({
				demo: {
					baseUrl: "https://example.com",
					apiKey: "DEMO_KEY",
					api: "anthropic-messages",
					compat: {
						supportsLongCacheRetention: false,
					},
					models: [
						{
							id: "demo-model",
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 1000,
							maxTokens: 100,
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("demo", "demo-model")?.compat as AnthropicMessagesCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(compat?.supportsLongCacheRetention).toBe(false);
		});

		test("model-level baseUrl overrides provider-level baseUrl for custom models", async () => {
			writeRawModelsJson({
				"opencode-go-custom": {
					baseUrl: "https://opencode.ai/zen/go/v1",
					apiKey: "TEST_KEY",
					models: [
						{
							id: "minimax-m2.5",
							api: "anthropic-messages",
							baseUrl: "https://opencode.ai/zen/go",
							reasoning: true,
							input: ["text"],
							cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
						{
							id: "glm-5",
							api: "openai-completions",
							reasoning: true,
							input: ["text"],
							cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
							contextWindow: 204800,
							maxTokens: 131072,
						},
					],
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const m25 = registry.find("opencode-go-custom", "minimax-m2.5");
			const glm5 = registry.find("opencode-go-custom", "glm-5");

			expect(m25?.baseUrl).toBe("https://opencode.ai/zen/go");
			expect(glm5?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		});
	});

	describe("modelOverrides (per-model customization)", () => {
		test("Anthropic model override replaces allowed fallback metadata", async () => {
			const allowedFallbackModels = [
				{
					provider: "anthropic",
					model: "claude-opus-5",
					cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				},
				{
					provider: "anthropic",
					model: "claude-opus-4-8",
					cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
				},
			];
			writeRawModelsJson({
				anthropic: {
					modelOverrides: {
						"claude-fable-5": {
							compat: { allowedFallbackModels },
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("anthropic", "claude-fable-5")?.compat as AnthropicMessagesCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(compat?.allowedFallbackModels).toEqual(allowedFallbackModels);
		});

		test("empty allowed fallback model override disables server-side fallback", async () => {
			writeRawModelsJson({
				anthropic: {
					modelOverrides: {
						"claude-fable-5": { compat: { allowedFallbackModels: [] } },
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const compat = registry.find("anthropic", "claude-fable-5")?.compat as AnthropicMessagesCompat | undefined;

			expect(registry.getError()).toBeUndefined();
			expect(compat?.allowedFallbackModels).toEqual([]);
		});

		test("model override deep-merges image resize limits", async () => {
			writeRawModelsJson({
				test: {
					baseUrl: "https://example.com",
					apiKey: "test-key",
					api: "openai-completions",
					models: [
						{
							id: "vision-model",
							input: ["text", "image"],
							inputLimits: {
								maxRequestBytes: 32 * 1024 * 1024,
								images: {
									maxPerRequest: 100,
									resize: {
										maxWidth: 2000,
										maxHeight: 2000,
										maxBytes: 4.5 * 1024 * 1024,
										jpegQuality: 80,
									},
								},
							},
						},
					],
					modelOverrides: {
						"vision-model": {
							inputLimits: {
								images: { resize: { maxWidth: 1568, maxBytes: 524288, jpegQuality: 75 } },
							},
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const model = registry.find("test", "vision-model");

			expect(registry.getError()).toBeUndefined();
			expect(model?.inputLimits).toMatchObject({
				maxRequestBytes: 32 * 1024 * 1024,
				images: {
					maxPerRequest: 100,
					resize: { maxWidth: 1568, maxHeight: 2000, maxBytes: 524288, jpegQuality: 75 },
				},
			});
		});

		test("model override with compat.openRouterRouting", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4.5": {
							compat: {
								openRouterRouting: { only: ["amazon-bedrock"] },
							},
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4.5");
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
		});

		test("model override deep merges compat settings", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4.5": {
							compat: {
								openRouterRouting: { order: ["anthropic", "together"] },
							},
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");
			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4.5");

			// Should have both the new routing AND preserve other compat settings
			const compat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			expect(compat?.openRouterRouting).toEqual({ order: ["anthropic", "together"] });
		});

		test("multiple model overrides on same provider", async () => {
			writeRawModelsJson({
				openrouter: {
					modelOverrides: {
						"anthropic/claude-sonnet-4.5": {
							compat: { openRouterRouting: { only: ["amazon-bedrock"] } },
						},
						"anthropic/claude-opus-4.1": {
							compat: { openRouterRouting: { only: ["anthropic"] } },
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const models = getModelsForProvider(registry, "openrouter");

			const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-4.5");
			const opus = models.find((m) => m.id === "anthropic/claude-opus-4.1");

			const sonnetCompat = sonnet?.compat as OpenAICompletionsCompat | undefined;
			const opusCompat = opus?.compat as OpenAICompletionsCompat | undefined;
			expect(sonnetCompat?.openRouterRouting).toEqual({ only: ["amazon-bedrock"] });
			expect(opusCompat?.openRouterRouting).toEqual({ only: ["anthropic"] });
		});
	});

	describe("dynamic provider lifecycle", () => {
		test("getProviderDisplayName resolves registered, OAuth, built-in, and fallback names", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);

			expect(registry.getProviderDisplayName("openai")).toBe("OpenAI");
			expect(registry.getProviderDisplayName("github-copilot")).toBe("GitHub Copilot");
			expect(registry.getProviderDisplayName("zai")).toBe("Z.AI");
			expect(registry.getProviderDisplayName("unknown-provider")).toBe("unknown-provider");

			registry.registerProvider("named-provider", {
				name: "Named Provider",
				baseUrl: "https://provider.test/v1",
				apiKey: "test-key",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});
			expect(registry.getProviderDisplayName("named-provider")).toBe("Named Provider");

			registry.registerProvider("oauth-provider", {
				baseUrl: "https://provider.test/v1",
				api: "openai-completions",
				oauth: {
					name: "OAuth Provider",
					login: async () => ({ access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});
			expect(registry.getProviderDisplayName("oauth-provider")).toBe("OAuth Provider");
		});

		test("modelOverrides apply to dynamically registered provider models", async () => {
			writeRawModelsJson({
				"extension-provider": {
					modelOverrides: {
						"extension-model": {
							name: "Overridden Extension Model",
							thinkingLevelMap: {
								off: null,
								minimal: null,
								low: null,
								medium: null,
								xhigh: "max",
							},
							headers: { "x-model-override": "enabled" },
						},
					},
				},
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			registry.registerProvider("extension-provider", {
				baseUrl: "https://provider.test/v1",
				apiKey: "test-key",
				api: "openai-completions",
				models: [
					{
						id: "extension-model",
						name: "Extension Model",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});

			const model = registry.find("extension-provider", "extension-model");
			expect(model).toBeDefined();
			if (!model) {
				throw new Error("extension model was not registered");
			}
			expect(model.name).toBe("Overridden Extension Model");
			expect(model.thinkingLevelMap).toEqual({
				off: null,
				minimal: null,
				low: null,
				medium: null,
				xhigh: "max",
			});
			expect(getSupportedThinkingLevels(model)).toEqual(["high", "xhigh"]);
			expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({
				ok: true,
				headers: { "x-model-override": "enabled" },
			});
		});

		test("registerProvider treats uppercase apiKey and headers as literals", async () => {
			const envKeys = ["CUSTOM_NAME", "BEARER", "MODEL_TOKEN"];
			const savedEnv: Record<string, string | undefined> = {};
			for (const key of envKeys) {
				savedEnv[key] = process.env[key];
				process.env[key] = `env-${key}`;
			}
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			try {
				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				registry.registerProvider("literal-provider", {
					...providerConfig("https://provider.test/v1", [{ id: "demo-model" }], "openai-completions"),
					apiKey: "CUSTOM_NAME",
					headers: { Authorization: "BEARER" },
					models: [
						{
							id: "demo-model",
							name: "demo-model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 8000,
							headers: { "x-model-token": "MODEL_TOKEN" },
						},
					],
				});

				expect(await registry.getApiKeyForProvider("literal-provider")).toBe("CUSTOM_NAME");
				const model = registry.find("literal-provider", "demo-model");
				expect(model).toBeDefined();
				expect(await registry.getApiKeyAndHeaders(model!)).toMatchObject({
					ok: true,
					apiKey: "CUSTOM_NAME",
					headers: {
						Authorization: "BEARER",
						"x-model-token": "MODEL_TOKEN",
					},
				});
				expect(warnSpy).not.toHaveBeenCalled();
			} finally {
				for (const key of envKeys) {
					if (savedEnv[key] === undefined) {
						delete process.env[key];
					} else {
						process.env[key] = savedEnv[key];
					}
				}
			}
		});

		test("failed registerProvider does not persist invalid streamSimple config", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);

			expect(() =>
				registry.registerProvider("broken-provider", {
					streamSimple: (() => {
						throw new Error("should not run");
					}) as any,
				}),
			).toThrow('Provider broken-provider: "api" is required when registering streamSimple.');

			await expect(registry.refresh()).resolves.toMatchObject({ aborted: false });
		});

		test("failed registerProvider does not remove existing provider models", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);

			registry.registerProvider("demo-provider", {
				baseUrl: "https://provider.test/v1",
				apiKey: "test-key",
				api: "openai-completions",
				models: [
					{
						id: "demo-model",
						name: "Demo Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();

			expect(() =>
				registry.registerProvider("demo-provider", {
					baseUrl: "https://provider.test/v2",
					apiKey: "test-key",
					models: [
						{
							id: "broken-model",
							name: "Broken Model",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 128000,
							maxTokens: 4096,
						},
					],
				}),
			).toThrow('Provider demo-provider, model broken-model: no "api" specified.');

			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
			await expect(registry.refresh()).resolves.toMatchObject({ aborted: false });
			expect(registry.find("demo-provider", "demo-model")).toBeDefined();
		});

		test("unregisterProvider removes the runtime OAuth overlay without mutating global state", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);

			registry.registerProvider("anthropic", {
				oauth: {
					name: "Custom Anthropic OAuth",
					login: async () => ({
						access: "custom-access-token",
						refresh: "custom-refresh-token",
						expires: Date.now() + 60_000,
					}),
					refreshToken: async (credentials) => credentials,
					getApiKey: (credentials) => credentials.access,
				},
			});

			expect(registry.getRegisteredProviderConfig("anthropic")?.oauth?.name).toBe("Custom Anthropic OAuth");

			registry.unregisterProvider("anthropic");

			expect(registry.getRegisteredProviderConfig("anthropic")).toBeUndefined();
		});

		test("streamSimple overlays do not mutate the global compat API registry", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);

			registry.registerProvider("stream-override-provider", {
				api: "openai-completions",
				streamSimple: () => {
					throw new Error("custom streamSimple override");
				},
			});

			let threwCustomOverride = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverride = error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverride).toBe(false);

			registry.unregisterProvider("stream-override-provider");

			let threwCustomOverrideAfterUnregister = false;
			try {
				getApiProvider("openai-completions")?.streamSimple(openAiModel, emptyContext);
			} catch (error) {
				threwCustomOverrideAfterUnregister = error instanceof Error && error.message === "custom streamSimple override";
			}
			expect(threwCustomOverrideAfterUnregister).toBe(false);
		});

		describe("dynamic provider override persistence", () => {
			test("baseUrl-only override keeps built-in provider models after refresh", async () => {
				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				registry.registerProvider("anthropic", { baseUrl: "https://proxy.test/anthropic" });
				await registry.refresh();

				const anthropicModels = getModelsForProvider(registry, "anthropic");
				expect(anthropicModels.length).toBeGreaterThan(1);
				expect(anthropicModels.every((m) => m.baseUrl === "https://proxy.test/anthropic")).toBe(true);
			});

			test("models-only override replaces built-in provider models after refresh", async () => {
				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				registry.registerProvider("anthropic", {
					...providerConfig("https://custom.test/anthropic", [{ id: "custom-claude" }], "anthropic-messages"),
					baseUrl: "https://custom.test/anthropic",
				});
				await registry.refresh();

				expect(getModelsForProvider(registry, "anthropic").map((m) => m.id)).toEqual(["custom-claude"]);
				expect(registry.find("anthropic", "custom-claude")?.baseUrl).toBe("https://custom.test/anthropic");
			});

			test("models plus baseUrl override replaces built-in provider models after refresh", async () => {
				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				registry.registerProvider("anthropic", {
					...providerConfig("https://custom.test/anthropic", [{ id: "custom-claude" }], "anthropic-messages"),
					baseUrl: "https://custom.test/anthropic",
				});
				registry.registerProvider("anthropic", { baseUrl: "https://proxy.test/anthropic" });
				await registry.refresh();

				expect(getModelsForProvider(registry, "anthropic").map((m) => m.id)).toEqual(["custom-claude"]);
				expect(registry.find("anthropic", "custom-claude")?.baseUrl).toBe("https://proxy.test/anthropic");
			});

			test("models-only custom provider registration survives refresh", async () => {
				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				await registry.refresh();

				expect(getModelsForProvider(registry, "custom-provider").map((m) => m.id)).toEqual(["custom-a", "custom-b"]);
			});

			test("baseUrl-only override keeps custom provider models after refresh", async () => {
				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				registry.registerProvider("custom-provider", { baseUrl: "https://proxy.test/custom" });
				await registry.refresh();

				expect(getModelsForProvider(registry, "custom-provider").map((m) => m.id)).toEqual(["custom-a", "custom-b"]);
				expect(
					getModelsForProvider(registry, "custom-provider").every((m) => m.baseUrl === "https://proxy.test/custom"),
				).toBe(true);
			});

			test("headers-only override keeps custom provider models after refresh", async () => {
				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				registry.registerProvider(
					"custom-provider",
					providerConfig("https://custom.test/v1", [{ id: "custom-a" }, { id: "custom-b" }], "openai-completions"),
				);
				registry.registerProvider("custom-provider", { headers: { "x-proxy": "enabled" } });
				await registry.refresh();

				const models = getModelsForProvider(registry, "custom-provider");
				expect(models.map((m) => m.id)).toEqual(["custom-a", "custom-b"]);
				expect(models.every((m) => m.baseUrl === "https://custom.test/v1")).toBe(true);
				expect(await registry.getApiKeyAndHeaders(models[0])).toMatchObject({
					ok: true,
					headers: { "x-proxy": "enabled" },
				});
			});
		});
	});

	describe("API key resolution", () => {
		/** Create provider config with custom apiKey */
		function providerWithApiKey(apiKey: string) {
			return {
				baseUrl: "https://example.com/v1",
				apiKey,
				api: "anthropic-messages",
				models: [
					{
						id: "test-model",
						name: "Test Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100000,
						maxTokens: 8000,
					},
				],
			};
		}

		test("apiKey with ! prefix executes command and uses stdout", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo test-api-key-from-command"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("test-api-key-from-command");
		});

		test("apiKey with ! prefix trims whitespace from command output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo '  spaced-key  '"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("spaced-key");
		});

		test("apiKey with ! prefix handles multiline output (uses trimmed result)", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf 'line1\\nline2'"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("line1\nline2");
		});

		test("returns undefined for a provider with no configured credential", async () => {
			const registry = await createModelRegistry(authStorage, modelsJsonPath);

			expect(await registry.getApiKeyForProvider("unconfigured-provider")).toBeUndefined();
		});

		test("apiKey with ! prefix rejects on command failure", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!exit 1"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			await expect(registry.getApiKeyForProvider("custom-provider")).rejects.toMatchObject({
				name: "ModelsError",
				code: "auth",
			});
		});

		test("apiKey with ! prefix rejects on nonexistent command", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!nonexistent-command-12345"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			await expect(registry.getApiKeyForProvider("custom-provider")).rejects.toMatchObject({
				name: "ModelsError",
				code: "auth",
			});
		});

		test("apiKey with ! prefix rejects on empty output", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!printf ''"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			await expect(registry.getApiKeyForProvider("custom-provider")).rejects.toMatchObject({
				name: "ModelsError",
				code: "auth",
			});
		});

		test("apiKey with $ prefix resolves to env value", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("$TEST_API_KEY_12345"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey with braced env syntax resolves to env value", async () => {
			const originalEnv = process.env.TEST_BRACED_API_KEY_12345;
			process.env.TEST_BRACED_API_KEY_12345 = "braced-env-api-key-value";
			const bracedKey = "${TEST_BRACED_API_KEY_12345}";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(bracedKey),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("braced-env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_BRACED_API_KEY_12345;
				} else {
					process.env.TEST_BRACED_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey interpolates braced env references inside literals", async () => {
			const originalPartA = process.env.TEST_INTERPOLATED_PART_A_12345;
			const originalPartB = process.env.TEST_INTERPOLATED_PART_B_12345;
			process.env.TEST_INTERPOLATED_PART_A_12345 = "left";
			process.env.TEST_INTERPOLATED_PART_B_12345 = "right";
			const interpolatedKey = ["$", "{TEST_INTERPOLATED_PART_A_12345}_$", "{TEST_INTERPOLATED_PART_B_12345}"].join("");

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(interpolatedKey),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("left_right");
			} finally {
				if (originalPartA === undefined) {
					delete process.env.TEST_INTERPOLATED_PART_A_12345;
				} else {
					process.env.TEST_INTERPOLATED_PART_A_12345 = originalPartA;
				}
				if (originalPartB === undefined) {
					delete process.env.TEST_INTERPOLATED_PART_B_12345;
				} else {
					process.env.TEST_INTERPOLATED_PART_B_12345 = originalPartB;
				}
			}
		});

		test("apiKey with $$ prefix escapes a leading dollar", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("$$TEST_API_KEY_12345"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("$TEST_API_KEY_12345");
		});

		test("apiKey with $! escapes a literal bang and still interpolates later env refs", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("$!literal-$TEST_API_KEY_12345"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("!literal-env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("plain apiKey is used directly even when it matches an env var", async () => {
			const originalEnv = process.env.TEST_API_KEY_12345;
			process.env.TEST_API_KEY_12345 = "env-api-key-value";

			try {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("TEST_API_KEY_12345"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const apiKey = await registry.getApiKeyForProvider("custom-provider");

				expect(apiKey).toBe("TEST_API_KEY_12345");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_API_KEY_12345;
				} else {
					process.env.TEST_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeRawModelsJson({
				"custom-provider": providerWithApiKey("literal_api_key_value"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("literal_api_key_value");
		});

		test("apiKey command can use shell features like pipes", async () => {
			writeRawModelsJson({
				"custom-provider": providerWithApiKey("!echo 'hello world' | tr ' ' '-'"),
			});

			const registry = await createModelRegistry(authStorage, modelsJsonPath);
			const apiKey = await registry.getApiKeyForProvider("custom-provider");

			expect(apiKey).toBe("hello-world");
		});

		describe("request-time resolution", () => {
			test("command is executed on every provider lookup", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");
				await registry.getApiKeyForProvider("custom-provider");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(3);
			});

			test("commands are re-executed across registry instances", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry1 = await createModelRegistry(authStorage, modelsJsonPath);
				await registry1.getApiKeyForProvider("custom-provider");

				const registry2 = await createModelRegistry(authStorage, modelsJsonPath);
				await registry2.getApiKeyForProvider("custom-provider");

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("different commands resolve independently", async () => {
				writeRawModelsJson({
					"provider-a": providerWithApiKey("!echo key-a"),
					"provider-b": providerWithApiKey("!echo key-b"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				const keyA = await registry.getApiKeyForProvider("provider-a");
				const keyB = await registry.getApiKeyForProvider("provider-b");

				expect(keyA).toBe("key-a");
				expect(keyB).toBe("key-b");
			});

			test("failed commands are retried", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; exit 1'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				await expect(registry.getApiKeyForProvider("custom-provider")).rejects.toMatchObject({ code: "auth" });
				await expect(registry.getApiKeyForProvider("custom-provider")).rejects.toMatchObject({ code: "auth" });

				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(2);
			});

			test("provider auth status reports apiKey environment variables from models.json", async () => {
				const envVarName = "TEST_API_KEY_STATUS_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "status-test-key";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(`$${envVarName}`),
					});

					const registry = await createModelRegistry(authStorage, modelsJsonPath);

					expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
						configured: true,
						source: "environment",
						label: envVarName,
					});
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("provider auth status reports interpolated apiKey environment variables", async () => {
				const envVarNameA = "TEST_API_KEY_STATUS_PART_A_98765";
				const envVarNameB = "TEST_API_KEY_STATUS_PART_B_98765";
				const originalEnvA = process.env[envVarNameA];
				const originalEnvB = process.env[envVarNameB];
				process.env[envVarNameA] = "left";
				process.env[envVarNameB] = "right";
				const interpolatedKey = ["$", "{", envVarNameA, "}_$", "{", envVarNameB, "}"].join("");

				try {
					writeRawModelsJson({
						"custom-provider": providerWithApiKey(interpolatedKey),
					});

					const registry = await createModelRegistry(authStorage, modelsJsonPath);

					expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
						configured: true,
						source: "environment",
						label: `${envVarNameA}, ${envVarNameB}`,
					});
				} finally {
					if (originalEnvA === undefined) {
						delete process.env[envVarNameA];
					} else {
						process.env[envVarNameA] = originalEnvA;
					}
					if (originalEnvB === undefined) {
						delete process.env[envVarNameB];
					} else {
						process.env[envVarNameB] = originalEnvB;
					}
				}
			});

			test("provider auth status reports non-env apiKey values from models.json as a config key", async () => {
				writeRawModelsJson({
					"custom-provider": providerWithApiKey("literal_api_key_value"),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
					configured: true,
					source: "models_json_key",
				});
			});

			test("missing explicit env apiKey keeps provider unavailable", async () => {
				const envVarName = "TEST_API_KEY_MISSING_TEST_98765";
				const originalEnv = process.env[envVarName];
				delete process.env[envVarName];

				try {
					writeRawModelsJson({
						"custom-provider": providerWithApiKey(`$${envVarName}`),
					});

					const registry = await createModelRegistry(authStorage, modelsJsonPath);

					expect(registry.getProviderAuthStatus("custom-provider")).toEqual({ configured: false });
					expect(registry.getAvailable().some((model) => model.provider === "custom-provider")).toBe(false);
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("provider auth status reports command apiKey values from models.json without executing them", async () => {
				const counterFile = join(tempDir, "status-counter");
				writeFileSync(counterFile, "0");
				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'echo 1 > "${counterPath}"; echo key-value'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				expect(registry.getProviderAuthStatus("custom-provider")).toEqual({
					configured: true,
					source: "models_json_command",
				});
				expect(readFileSync(counterFile, "utf-8")).toBe("0");
			});

			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_API_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeRawModelsJson({
						"custom-provider": providerWithApiKey(`$${envVarName}`),
					});

					const registry = await createModelRegistry(authStorage, modelsJsonPath);

					const key1 = await registry.getApiKeyForProvider("custom-provider");
					expect(key1).toBe("first-value");

					process.env[envVarName] = "second-value";

					const key2 = await registry.getApiKeyForProvider("custom-provider");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});

			test("getAvailable does not execute command-backed apiKey resolution", async () => {
				const counterFile = join(tempDir, "counter");
				writeFileSync(counterFile, "0");

				const counterPath = toShPath(counterFile);
				const command = `!sh -c 'count=$(cat "${counterPath}"); echo $((count + 1)) > "${counterPath}"; echo "key-value"'`;
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(command),
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const available = registry.getAvailable();

				expect(available.some((m) => m.provider === "custom-provider")).toBe(true);
				const count = parseInt(readFileSync(counterFile, "utf-8").trim(), 10);
				expect(count).toBe(0);
			});

			test("getAvailable filters GitHub Copilot OAuth models to account picker availability", async () => {
				const copilotModel = getBuiltinModels("github-copilot")[0];
				if (!copilotModel) throw new Error("Expected at least one GitHub Copilot model");

				await authStorage.modify("github-copilot", async () => ({
					type: "oauth",
					refresh: "github-access-token",
					access: "tid=test;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
					expires: Date.now() + 60_000,
					availableModelIds: [copilotModel.id],
				}));

				const registry = await createModelRegistry(authStorage, modelsJsonPath);

				expect(
					registry
						.getAvailable()
						.filter((m) => m.provider === "github-copilot")
						.map((m) => m.id),
				).toEqual([copilotModel.id]);
			});

			test("getApiKeyAndHeaders resolves authHeader on every request", async () => {
				const tokenFile = join(tempDir, "token");
				writeFileSync(tokenFile, "token-1");
				const tokenPath = toShPath(tokenFile);

				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey(`!sh -c 'cat "${tokenPath}"'`),
						authHeader: true,
					},
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const model = registry.find("custom-provider", "test-model");
				expect(model).toBeDefined();

				const auth1 = await registry.getApiKeyAndHeaders(model!);
				expect(auth1).toEqual({
					ok: true,
					apiKey: "token-1",
					headers: { Authorization: "Bearer token-1" },
				});

				writeFileSync(tokenFile, "token-2");

				const auth2 = await registry.getApiKeyAndHeaders(model!);
				expect(auth2).toEqual({
					ok: true,
					apiKey: "token-2",
					headers: { Authorization: "Bearer token-2" },
				});
			});

			test("getApiKeyAndHeaders resolves configured auth exactly once", async () => {
				const counterFile = join(tempDir, "auth-counter");
				writeFileSync(counterFile, "0");
				const counterPath = toShPath(counterFile);
				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey(
							`!sh -c 'count=$(cat "${counterPath}"); count=$((count + 1)); echo "$count" > "${counterPath}"; echo "token-$count"'`,
						),
						authHeader: true,
					},
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const auth = await registry.getApiKeyAndHeaders(registry.find("custom-provider", "test-model")!);

				expect(auth).toEqual({
					ok: true,
					apiKey: "token-1",
					headers: { Authorization: "Bearer token-1" },
				});
				expect(readFileSync(counterFile, "utf-8").trim()).toBe("1");
			});

			test("stored credentials bypass lower-priority configured auth commands", async () => {
				const counterFile = join(tempDir, "fallback-counter");
				writeFileSync(counterFile, "0");
				const counterPath = toShPath(counterFile);
				writeRawModelsJson({
					"custom-provider": providerWithApiKey(`!sh -c 'echo 1 > "${counterPath}"; echo fallback-key'`),
				});
				await authStorage.modify("custom-provider", async () => ({ type: "api_key", key: "stored-key" }));

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const auth = await registry.getApiKeyAndHeaders(registry.find("custom-provider", "test-model")!);

				expect(auth).toMatchObject({ ok: true, apiKey: "stored-key" });
				expect(readFileSync(counterFile, "utf-8").trim()).toBe("0");
			});

			test("getApiKeyAndHeaders preserves the legacy missing-key authHeader error", async () => {
				writeRawModelsJson({
					"custom-provider": {
						baseUrl: "https://example.test/v1",
						api: "openai-completions",
						authHeader: true,
						models: [{ id: "test-model" }],
					},
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const auth = await registry.getApiKeyAndHeaders(registry.find("custom-provider", "test-model")!);

				expect(auth).toEqual({ ok: false, error: 'No API key found for "custom-provider"' });
			});

			test("getApiKeyAndHeaders returns an error for failed authHeader resolution", async () => {
				writeRawModelsJson({
					"custom-provider": {
						...providerWithApiKey("!exit 1"),
						authHeader: true,
					},
				});

				const registry = await createModelRegistry(authStorage, modelsJsonPath);
				const model = registry.find("custom-provider", "test-model");
				expect(model).toBeDefined();

				const auth = await registry.getApiKeyAndHeaders(model!);
				expect(auth.ok).toBe(false);
				if (!auth.ok) {
					expect(auth.error).toContain('Failed to resolve API key for provider "custom-provider"');
				}
			});
		});
	});
});
