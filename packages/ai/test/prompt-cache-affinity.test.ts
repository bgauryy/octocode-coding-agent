import { describe, expect, it } from "vitest";
import { resolveOpenAIResponsesCacheFields } from "../src/api/openai-prompt-cache.ts";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import { normalizeContext } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { resolvePromptCacheKey } from "../src/utils/cache-policy.ts";

const compat = { supportsExplicitPromptCacheMode: true, supportsLongCacheRetention: true };

describe("prompt cache affinity", () => {
	it("uses explicit grouping, then the injected environment, then the transport session", () => {
		const env = { OCTOCODE_PROMPT_CACHE_KEY: "siblings" };
		expect(resolvePromptCacheKey({ sessionId: "child-a", env })).toBe("siblings");
		expect(resolvePromptCacheKey({ sessionId: "child-b", env })).toBe("siblings");
		expect(resolvePromptCacheKey({ sessionId: "child-a", promptCacheKey: "override", env })).toBe("override");
		expect(resolvePromptCacheKey({ sessionId: "child-a", env: {} })).toBe("child-a");
	});
	it.each([false, true])("preserves grouping with subscription=%s and honors disabled caching", (subscription) => {
		const options = { sessionId: "child-a", env: { OCTOCODE_PROMPT_CACHE_KEY: "siblings" } };
		expect(resolveOpenAIResponsesCacheFields(compat, options, subscription).prompt_cache_key).toBe("siblings");
		expect(
			resolveOpenAIResponsesCacheFields(compat, { ...options, cacheRetention: "none" }, subscription).prompt_cache_key,
		).toBeUndefined();
	});
	it("keeps explicit grouping through simple option conversion and clamps only the wire key", () => {
		const options = buildBaseOptions(getBuiltinModel("openai", "gpt-4o-mini"), normalizeContext({ messages: [] }), {
			sessionId: "child-a",
			promptCacheKey: "x".repeat(100),
		});
		expect(options.sessionId).toBe("child-a");
		expect(options.promptCacheKey).toHaveLength(100);
		expect(resolveOpenAIResponsesCacheFields(compat, options, false).prompt_cache_key).toBe("x".repeat(64));
	});
});
