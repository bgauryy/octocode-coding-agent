import { describe, expect, it } from "vitest";
import { resolveOpenAIResponsesCacheFields } from "../src/api/openai-prompt-cache.ts";
import { isChatGPTSignIn } from "../src/api/openai-responses/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";

const explicit = { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true };
const legacy = { supportsExplicitPromptCacheMode: false, supportsLongCacheRetention: true };
const sessionId = "session-1";

describe("resolveOpenAIResponsesCacheFields", () => {
	it.each([
		// [compat, history, instructions, expected fields]
		[explicit, "short", "long", { prompt_cache_key: sessionId, instructionCacheTtl: "12h" }],
		[
			explicit,
			"long",
			"long",
			{ prompt_cache_key: sessionId, prompt_cache_options: { ttl: "12h" }, instructionCacheTtl: "12h" },
		],
		[explicit, "short", "short", { prompt_cache_key: sessionId, instructionCacheTtl: "30m" }],
		// A 12h breakpoint may follow a 30m one, unlike Anthropic's ordering rule.
		[
			explicit,
			"long",
			"short",
			{ prompt_cache_key: sessionId, prompt_cache_options: { ttl: "12h" }, instructionCacheTtl: "30m" },
		],
		[explicit, "short", undefined, { prompt_cache_key: sessionId }],
		[explicit, "none", "long", { prompt_cache_key: undefined, prompt_cache_options: { mode: "explicit" } }],
		[
			{ ...explicit, supportsLongCacheRetention: false },
			"long",
			"long",
			{ prompt_cache_key: sessionId, instructionCacheTtl: "30m" },
		],
		[legacy, "long", undefined, { prompt_cache_key: sessionId, prompt_cache_retention: "24h" }],
		[legacy, "short", "long", { prompt_cache_key: sessionId }],
		[legacy, "none", undefined, { prompt_cache_key: undefined }],
		[{ ...legacy, supportsLongCacheRetention: false }, "long", undefined, { prompt_cache_key: sessionId }],
	] as const)("maps %o history=%s instructions=%s", (compat, history, instructions, expected) => {
		expect(
			resolveOpenAIResponsesCacheFields(
				compat,
				{ cacheRetention: history, instructionCacheRetention: instructions, sessionId },
				false,
			),
		).toEqual(expected);
	});

	it("keeps only the key for credentials that reject the cache parameters", () => {
		expect(
			resolveOpenAIResponsesCacheFields(
				explicit,
				{ cacheRetention: "long", instructionCacheRetention: "long", sessionId },
				true,
			),
		).toEqual({ prompt_cache_key: sessionId });
	});

	it("clamps the key to 64 characters", () => {
		const key = resolveOpenAIResponsesCacheFields(legacy, { sessionId: "x".repeat(80) }, false).prompt_cache_key;
		expect(key).toHaveLength(64);
	});
});

describe("isChatGPTSignIn", () => {
	const model = getBuiltinModel("openai", "gpt-6-luna");
	it.each([
		["https://api.openai.com/v1", "token", true],
		["https://api.openai.com/v1/", "token", true],
		["https://api.openai.com/v1", "sk-proj-123", false],
		["https://proxy.example/v1", "token", false],
	] as const)("treats %s with %s as sign-in: %s", (baseUrl, apiKey, expected) => {
		expect(isChatGPTSignIn({ ...model, baseUrl }, apiKey)).toBe(expected);
	});
});
