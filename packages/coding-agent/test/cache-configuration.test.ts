import type { Model } from "@octocodeai/octocode-ai";
import { getModel } from "@octocodeai/octocode-ai/compat";
import { withCacheCapabilities, withCacheEndpoint } from "@octocodeai/octocode-ai/utils/cache-capabilities";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeCachePolicy, resolveConfiguredCache } from "../src/core/cache-configuration.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

afterEach(() => vi.unstubAllEnvs());

describe("cache configuration", () => {
	const model = getModel("openai", "gpt-6.1-sol");
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
		const manager = SettingsManager.inMemory();
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
		const trusted = SettingsManager.fromStorage(storage);
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
			resolveConfiguredCache(
				model,
				provider,
				{ cacheRetention: "none", instructionCacheRetention: "long" },
				settings,
			).options,
		).toEqual({ cacheRetention: "none", instructionCacheRetention: "none" });
	});
	it("caps history at the instruction retention, since a longer history breakpoint cannot follow a shorter one", () => {
		environment();
		vi.stubEnv("OCTOCODE_INSTRUCTION_CACHE_RETENTION", "short");
		const policy = resolveConfiguredCache(model, undefined, {}, [{ source: "global", values: { cacheRetention: "long" } }]);
		expect(policy.options).toEqual({ cacheRetention: "short", instructionCacheRetention: "short" });
		expect(policy.sources.cacheRetention).toBe("global (capped by instruction retention)");
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
});
