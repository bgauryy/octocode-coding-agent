import type { Api, Model } from "@octocodeai/octocode-ai";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { withCacheCapabilities, withCacheEndpoint } from "@octocodeai/octocode-ai/utils/cache-capabilities";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeCachePolicy, resolveConfiguredCache } from "../src/core/cache-configuration.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

afterEach(() => vi.unstubAllEnvs());

describe("cache configuration", () => {
	const model = getBuiltinModel("openai", "gpt-6.1-sol");
	const environment = () => {
		vi.stubEnv("OCTOCODE_CACHE_RETENTION", undefined);
		vi.stubEnv("OCTOCODE_INSTRUCTION_CACHE_RETENTION", undefined);
	};
	it("uses application defaults without changing the environment", () => {
		environment();
		// Long instructions, short history: the history is written every turn and read again within minutes.
		expect(resolveConfiguredCache(model, undefined).options).toEqual({
			cacheRetention: "short",
			instructionCacheRetention: "long",
		});
		expect(process.env.OCTOCODE_CACHE_RETENTION).toBeUndefined();
	});
	it("keeps the long instruction default for a model models.json re-declares on Anthropic's own host", () => {
		environment();
		const opus: Model<"anthropic-messages"> = {
			id: "claude-opus-5-5",
			name: "Claude Opus 5.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 128000,
		};
		expect(
			resolveConfiguredCache(opus, { models: [{ id: "claude-opus-5-5", contextWindow: 500000 }] }).options,
		).toEqual({
			cacheRetention: "short",
			instructionCacheRetention: "long",
		});
	});
	it("defaults a models.json Anthropic-style model to the short tier unless it declares long retention", () => {
		environment();
		const custom = (compat?: Model<"anthropic-messages">["compat"]): Model<"anthropic-messages"> => ({
			id: "my-claude",
			name: "My Claude",
			api: "anthropic-messages",
			provider: "gateway",
			baseUrl: "https://gateway.example/anthropic",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
			...(compat ? { compat } : {}),
		});
		const provider = { baseUrl: "https://gateway.example/anthropic", models: [{ id: "my-claude" }] };
		expect(resolveConfiguredCache(custom(), provider)).toEqual({
			options: { cacheRetention: "short", instructionCacheRetention: "short" },
			sources: { cacheRetention: "defaults", instructionCacheRetention: "defaults" },
		});
		expect(describeCachePolicy(custom(), resolveConfiguredCache(custom(), provider))).toContain(
			"Instructions 5m; history 5m.",
		);
		const declared = custom({ supportsLongCacheRetention: true });
		expect(resolveConfiguredCache(declared, provider).options).toEqual({
			cacheRetention: "short",
			instructionCacheRetention: "long",
		});
		// An explicit preference still wins over the default.
		const settings = [{ source: "global settings", values: { cacheRetention: "long" as const } }];
		expect(resolveConfiguredCache(custom(), provider, {}, settings).options.cacheRetention).toBe("long");
		// Built-in models outside models.json keep the long instruction default.
		for (const builtin of [
			getBuiltinModel("anthropic", "claude-opus-5-5"),
			getBuiltinModel("openrouter", "anthropic/claude-fable-5.2"),
		]) {
			expect(resolveConfiguredCache(builtin, undefined).options.instructionCacheRetention).toBe("long");
		}
	});
	it("persists settings and applies session overrides without changing stored preferences", async () => {
		const manager = SettingsManager.inMemory({}, { projectTrusted: true });
		manager.setCachePreference("cacheRetention", "long");
		await manager.flush();
		manager.reload();
		expect(manager.getCachePreferences()).toEqual({ cacheRetention: "long", instructionCacheRetention: "long" });
		manager.applyOverrides({ cacheRetention: "short" });
		expect(manager.getCachePreferences()).toEqual({ cacheRetention: "short", instructionCacheRetention: "short" });
	});
	it("applies project pair overrides only for trusted projects", () => {
		const storage = {
			withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined) {
				fn(
					JSON.stringify(
						scope === "global"
							? { cacheRetention: "long", instructionCacheRetention: "long" }
							: { cacheRetention: "short" },
					),
				);
			},
		};
		const trusted = SettingsManager.fromStorage(storage, { projectTrusted: true });
		expect(trusted.getCachePreferences()).toEqual({ cacheRetention: "short", instructionCacheRetention: "short" });
		expect(trusted.getSettings().instructionCacheRetention).toBe("short");
		const untrusted = SettingsManager.fromStorage(storage, { projectTrusted: false });
		expect(untrusted.getCachePreferences()).toEqual({ cacheRetention: "long", instructionCacheRetention: "long" });
	});
	it("resolves every layer with legacy pair semantics and reports the winning source", () => {
		environment();
		const provider = {
			cacheRetention: "long" as const,
			models: [{ id: model.id, cacheRetention: "short" as const }],
			modelOverrides: { [model.id]: { instructionCacheRetention: "long" as const } },
		};
		const settings = [
			{ source: "global", values: { cacheRetention: "none" as const } },
			{ source: "project", values: { cacheRetention: "long" as const } },
		];
		const policy = resolveConfiguredCache(model, provider, {}, settings);
		expect(policy.options).toEqual({ cacheRetention: "short", instructionCacheRetention: "long" });
		expect(policy.sources).toEqual({ cacheRetention: "model", instructionCacheRetention: "model override" });
		vi.stubEnv("OCTOCODE_CACHE_RETENTION", "short");
		expect(resolveConfiguredCache(model, provider, {}, settings).options.instructionCacheRetention).toBe("short");
		expect(
			resolveConfiguredCache(model, provider, { instructionCacheRetention: "long" }, settings).sources
				.instructionCacheRetention,
		).toBe("request");
		expect(
			resolveConfiguredCache(model, provider, { cacheRetention: "none", instructionCacheRetention: "long" }, settings)
				.options,
		).toEqual({ cacheRetention: "none", instructionCacheRetention: "none" });
	});
	it("keeps long history behind short instructions; adapters with an ordering rule apply it themselves", () => {
		environment();
		vi.stubEnv("OCTOCODE_INSTRUCTION_CACHE_RETENTION", "short");
		const policy = resolveConfiguredCache(model, undefined, {}, [
			{ source: "global", values: { cacheRetention: "long" } },
		]);
		expect(policy.options).toEqual({ cacheRetention: "long", instructionCacheRetention: "short" });
		expect(policy.sources.cacheRetention).toBe("global");
		// Equal or longer instruction retention is untouched; "none" instructions leave history as configured.
		expect(resolveConfiguredCache(model, undefined, { cacheRetention: "long" }).options).toEqual({
			cacheRetention: "long",
			instructionCacheRetention: "long",
		});
		vi.stubEnv("OCTOCODE_INSTRUCTION_CACHE_RETENTION", "none");
		expect(
			resolveConfiguredCache(model, undefined, {}, [{ source: "global", values: { cacheRetention: "long" } }]).options,
		).toEqual({ cacheRetention: "long", instructionCacheRetention: "none" });
	});
	it("rejects invalid values without echoing them", () => {
		environment();
		vi.stubEnv("OCTOCODE_CACHE_RETENTION", "private-invalid-value");
		expect(() => resolveConfiguredCache(model, undefined)).toThrow(
			"Invalid OCTOCODE_CACHE_RETENTION: expected none, short, or long",
		);
	});
	it("uses documented capabilities independently of price and respects explicit overrides", () => {
		const unpriced: Model<"openai-responses"> = {
			...model,
			compat: undefined,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		expect(withCacheCapabilities(unpriced).compat?.supportsExplicitPromptCacheMode).toBe(true);
		expect(withCacheCapabilities({ ...unpriced, id: "unknown-new-model" }).compat).toBeUndefined();
		expect(
			withCacheCapabilities({ ...unpriced, compat: { supportsExplicitPromptCacheMode: false } }).compat
				?.supportsExplicitPromptCacheMode,
		).toBe(false);
	});
	it("invalidates direct-provider capabilities when the endpoint changes", () => {
		environment();
		const proxy = withCacheEndpoint(model, "https://proxy.example/v1");
		expect(proxy.compat?.supportsExplicitPromptCacheMode).toBe(false);
		expect(proxy.compat?.supportsLongCacheRetention).toBe(false);
		expect(proxy.promptCache).toBeUndefined();
		expect(describeCachePolicy(proxy, resolveConfiguredCache(proxy, undefined))).toContain(
			"separate instruction lifetime is unsupported",
		);
	});

	describe("describeCachePolicy", () => {
		const describeWith = (
			target: Model<Api>,
			values: { cacheRetention?: "none" | "short" | "long"; instructionCacheRetention?: "none" | "short" | "long" },
			subscription = false,
		) => {
			environment();
			return describeCachePolicy(target, resolveConfiguredCache(target, undefined, values), subscription);
		};
		const asApi = <A extends Api>(api: A, overrides: Partial<Model<A>> = {}) =>
			withCacheCapabilities({ ...model, api, compat: undefined, ...overrides });

		it("says explicit OpenAI none means no caching at all", () => {
			const text = describeWith(model, { cacheRetention: "none" });
			expect(text).toContain("no caching at all");
			expect(text).not.toContain("may still cache automatically");
		});
		it("reports the explicit 12h tier on the instructions, and history on the request's 30m", () => {
			expect(describeWith(model, { cacheRetention: "long", instructionCacheRetention: "long" })).toContain(
				"Instructions 12h; history 30m (the 12h tier goes on instruction breakpoints only).",
			);
			expect(describeWith(model, { cacheRetention: "short", instructionCacheRetention: "long" })).toContain(
				"Instructions 12h; history 30m.",
			);
		});
		it("shows the 24h tier on older OpenAI models only when long and supported", () => {
			const older = asApi("openai-responses", { id: "gpt-5.5", compat: { supportsExplicitPromptCacheMode: false } });
			expect(describeWith(older, { cacheRetention: "long" })).toContain("24h extended retention");
			expect(describeWith(older, { cacheRetention: "short" })).not.toContain("24h");
			expect(describeWith(older, { cacheRetention: "none" })).toContain("No cache key is sent");
			const proxy = asApi("openai-responses", {
				provider: "custom",
				baseUrl: "https://proxy.example/v1",
				compat: { supportsExplicitPromptCacheMode: false },
			});
			expect(describeWith(proxy, { cacheRetention: "long" })).not.toContain("24h");
		});
		it("shows 1h and 5m for Anthropic-style markers on Anthropic, Bedrock and OpenRouter Claude", () => {
			const claude = [
				asApi("anthropic-messages", { provider: "anthropic", baseUrl: "https://api.anthropic.com" }),
				asApi("bedrock-converse-stream", { id: "us.anthropic.claude-sonnet-4-5" }),
				asApi("openai-completions", { provider: "openrouter", id: "anthropic/claude-sonnet-4.5" }),
			];
			for (const target of claude) {
				expect(describeWith(target, { cacheRetention: "short", instructionCacheRetention: "long" })).toContain(
					"Instructions 1h; history 5m.",
				);
				expect(describeWith(target, { cacheRetention: "none" })).toContain("No cache markers are sent");
				// A 1h entry cannot follow a 5m one, so the request sends long history at 5m.
				expect(describeWith(target, { cacheRetention: "long", instructionCacheRetention: "short" })).toContain(
					"Instructions 5m; history 5m (1h history cannot follow 5m instructions).",
				);
			}
			// OpenAI explicit mode keeps the history on the request's 30m TTL, whatever the instructions get.
			expect(describeWith(model, { cacheRetention: "long", instructionCacheRetention: "short" })).toContain(
				"Instructions 30m; history 30m (the 12h tier goes on instruction breakpoints only).",
			);
		});
		// Azure OpenAI Responses sends `prompt_cache_retention: "24h"` only where `azureAcceptsExtendedRetention` says so:
		// /status uses that same check, not a declared lifetime the adapter never sends.
		it("names the Azure 24h tier for long history only where the adapter requests it", () => {
			const azure = (id: string, overrides: Partial<Model<"azure-openai-responses">> = {}) =>
				asApi("azure-openai-responses", { id, ...overrides });
			const long = { cacheRetention: "long" } as const;
			expect(describeWith(azure("gpt-5.5"), long)).toContain("24h extended retention requested");
			expect(describeWith(azure("gpt-5.5"), { cacheRetention: "short" })).not.toMatch(/\b24h\b/);
			expect(describeWith(azure("gpt-6.1-sol"), long)).toContain("Provider-managed");
			expect(describeWith(azure("gpt-6.1-sol"), long)).not.toMatch(/\b24h\b/);
			// A custom deployment that declares a long lifetime but is not on Microsoft's list sends no retention field.
			const declared = azure("team-deployment", { promptCache: { short: 300, long: 86_400 } });
			expect(describeWith(declared, long)).toContain("Provider-managed");
			expect(describeWith(declared, long)).not.toMatch(/\b24h\b/);
			// `compat.supportsLongCacheRetention: true` opts a deployment-named model in; `false` opts a listed one out.
			const optedIn = azure("team-deployment", { compat: { supportsLongCacheRetention: true } });
			expect(describeWith(optedIn, long)).toContain("24h extended retention requested");
			const optedOut = azure("gpt-5.5", { compat: { supportsLongCacheRetention: false } });
			expect(describeWith(optedOut, long)).not.toMatch(/\b24h\b/);
		});
		// GPT-6 Astra on Azure gets 30m explicit breakpoints on its instructions (`azureInstructionCacheTtl`) in implicit mode.
		it("names Azure GPT-6 Astra's 30m instruction breakpoints only when the adapter sends them", () => {
			const astra = getBuiltinModel("azure", "gpt-6-astra");
			const longText = describeWith(astra, { cacheRetention: "long", instructionCacheRetention: "long" });
			expect(longText).toContain("Provider-managed");
			expect(longText).toContain("Instructions carry a 30m cache breakpoint.");
			expect(longText).not.toMatch(/\b(12h|24h)\b/);
			expect(describeWith(astra, { cacheRetention: "short", instructionCacheRetention: "short" })).toContain(
				"Instructions carry a 30m cache breakpoint.",
			);
			expect(describeWith(astra, { cacheRetention: "long", instructionCacheRetention: "none" })).not.toContain(
				"breakpoint",
			);
			expect(describeWith(astra, { cacheRetention: "none" })).not.toContain("breakpoint");
			expect(describeWith(asApi("azure-openai-responses"), { cacheRetention: "long" })).not.toContain("breakpoint");
		});
		// `compat.supportsExplicitPromptCacheMode: true` on an Azure deployment: explicit mode with a request-wide TTL that
		// every breakpoint inherits, so the request TTL is the longer of the instruction and history tiers.
		it("names the Azure explicit-mode opt-in's request TTL", () => {
			const optedIn = asApi("azure-openai-responses", {
				id: "team-gpt-6",
				compat: { supportsExplicitPromptCacheMode: true },
			});
			const long = describeWith(optedIn, { cacheRetention: "long", instructionCacheRetention: "long" });
			expect(long).toContain("Explicit mode opted in; request TTL 12h covers instruction breakpoints and history.");
			expect(describeWith(optedIn, { cacheRetention: "short", instructionCacheRetention: "long" })).toContain(
				"request TTL 12h covers instruction breakpoints and history.",
			);
			expect(describeWith(optedIn, { cacheRetention: "short", instructionCacheRetention: "short" })).toContain(
				"request TTL 30m covers instruction breakpoints and history.",
			);
			// Instructions `none` sends no breakpoints, so the text names none.
			for (const history of ["short", "long"] as const) {
				const text = describeWith(optedIn, { cacheRetention: history, instructionCacheRetention: "none" });
				expect(text).toContain(
					`Explicit mode opted in; request TTL ${history === "long" ? "12h" : "30m"} covers history.`,
				);
				expect(text).not.toContain("breakpoint");
			}
			expect(describeWith(optedIn, { cacheRetention: "none", instructionCacheRetention: "long" })).toContain(
				"Explicit mode with no breakpoints",
			);
			const capped = asApi("azure-openai-responses", {
				id: "team-gpt-6",
				compat: { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: false },
			});
			expect(describeWith(capped, { cacheRetention: "long", instructionCacheRetention: "long" })).toContain(
				"request TTL 30m",
			);
		});
		it("says provider-managed for Azure, Mistral, Google and generic completions", () => {
			for (const api of [
				"azure-openai-responses",
				"mistral-conversations",
				"google-generative-ai",
				"google-vertex",
				"openai-completions",
			] as const) {
				const text = describeWith(asApi(api), { cacheRetention: "long", instructionCacheRetention: "long" });
				expect(text, api).toContain("Provider-managed");
				expect(text, api).not.toMatch(/\b(1h|12h|24h)\b/);
			}
		});
	});
});
