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
		expect(resolveConfiguredCache(model, undefined).options).toEqual({
			cacheRetention: "short",
			instructionCacheRetention: "long",
		});
		expect(process.env.OCTOCODE_CACHE_RETENTION).toBeUndefined();
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
			({ ...model, api, compat: undefined, ...overrides }) as unknown as Model<Api>;

		it("says explicit OpenAI none means no caching at all", () => {
			const text = describeWith(model, { cacheRetention: "none" });
			expect(text).toContain("no caching at all");
			expect(text).not.toContain("may still cache automatically");
		});
		it("reports the explicit 12h tier for long history and instructions", () => {
			expect(describeWith(model, { cacheRetention: "long", instructionCacheRetention: "long" })).toContain(
				"Instructions 12h; history 12h.",
			);
			expect(describeWith(model, { cacheRetention: "short", instructionCacheRetention: "long" })).toContain(
				"Instructions 12h; history 30m.",
			);
		});
		it("shows the 24h tier on older OpenAI models only when long and supported", () => {
			const older = asApi("openai-responses", { compat: { supportsExplicitPromptCacheMode: false } });
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
				asApi("anthropic-messages"),
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
			// OpenAI has no ordering rule: a 12h history breakpoint may follow 30m instructions.
			expect(describeWith(model, { cacheRetention: "long", instructionCacheRetention: "short" })).toContain(
				"Instructions 30m; history 12h.",
			);
		});
		it("says provider-managed for Azure, Codex, Mistral, Google and generic completions", () => {
			for (const api of [
				"azure-openai-responses",
				"openai-codex-responses",
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
