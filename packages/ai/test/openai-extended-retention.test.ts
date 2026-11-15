/**
 * OpenAI's 24h extended retention (`prompt_cache_retention: "24h"`) is documented only for some models, and GPT-5.6
 * and later replace it with `prompt_cache_options.ttl`, which Chat Completions accepts only as "30m":
 * https://developers.openai.com/api/docs/guides/prompt-caching and the Chat Completions create reference.
 */
import { describe, expect, it } from "vitest";
import { buildParams as buildCompletionsParams } from "../src/api/openai-completions/params.ts";
import { getCompat as getResponsesCompat } from "../src/api/openai-responses/compat.ts";
import { buildParams as buildResponsesParams } from "../src/api/openai-responses/request.ts";
import { resolveModelCapabilities } from "../src/models/capabilities.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Model } from "../src/types.ts";
import { withCacheCapabilities } from "../src/utils/cache-capabilities.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: 0 }] });
const options = { apiKey: "sk-test", cacheRetention: "long", sessionId: "s1" } as const;

interface CachePayload {
	prompt_cache_key?: string | null;
	prompt_cache_retention?: string | null;
	prompt_cache_options?: unknown;
}

/** The cache fields of a Responses request, read without the SDK's deprecated field type. */
function responsesPayload(model: Model<"openai-responses">): CachePayload {
	return buildResponsesParams(model, context, options, getResponsesCompat(model), new Map(), undefined);
}

/** The cache fields of a Chat Completions request, read without the SDK's deprecated field type. */
function completionsPayload(model: Model<"openai-completions">): CachePayload {
	return buildCompletionsParams(model, context, options);
}

function completionsModel(id: string, compat?: Model<"openai-completions">["compat"]): Model<"openai-completions"> {
	return withCacheCapabilities({
		id,
		name: id,
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		compat,
	});
}

describe("OpenAI Responses 24h extended retention", () => {
	it.each(["gpt-4o", "gpt-4o-mini", "gpt-5-mini", "o3", "gpt-5.3-codex", "gpt-5.4-mini"] as const)(
		"%s: outside the documented list, no 24h field and no long lifetime",
		(id) => {
			const model = getBuiltinModel("openai", id);
			const payload = responsesPayload(model);
			expect(payload.prompt_cache_retention).toBeUndefined();
			expect(payload.prompt_cache_key).toBe("s1");
			expect(resolveModelCapabilities(model).cache).toEqual({ mechanism: "key", lifetimes: {} });
		},
	);

	it.each(["gpt-4.1", "gpt-5", "gpt-5.1", "gpt-5.2", "gpt-5.4", "gpt-5.5", "gpt-5.5-pro"] as const)(
		"%s: on the documented list, 24h retention and a 24h lifetime",
		(id) => {
			const model = getBuiltinModel("openai", id);
			expect(responsesPayload(model).prompt_cache_retention).toBe("24h");
			expect(resolveModelCapabilities(model).cache).toEqual({ mechanism: "key", lifetimes: { long: 86_400 } });
		},
	);

	it("lets compat.supportsLongCacheRetention opt an unlisted model in", () => {
		const base = getBuiltinModel("openai", "gpt-4o");
		const model = { ...base, compat: { ...base.compat, supportsLongCacheRetention: true } };
		expect(responsesPayload(model).prompt_cache_retention).toBe("24h");
	});

	it("keeps the 12h explicit mode for GPT-5.6 and later", () => {
		const model = getBuiltinModel("openai", "gpt-5.6-sol");
		const payload = responsesPayload(model);
		expect(payload.prompt_cache_retention).toBeUndefined();
		expect(payload.prompt_cache_options).toEqual({ ttl: "12h" });
	});
});

describe("OpenAI Chat Completions 24h extended retention", () => {
	it.each(["gpt-4o", "o3", "gpt-5-mini"])("%s on api.openai.com: no 24h field", (id) => {
		const params = completionsPayload(completionsModel(id));
		expect(params.prompt_cache_retention).toBeUndefined();
		expect(params.prompt_cache_key).toBe("s1");
	});

	it("gpt-4.1 on api.openai.com: 24h retention", () => {
		expect(completionsPayload(completionsModel("gpt-4.1")).prompt_cache_retention).toBe("24h");
	});

	it.each(["gpt-5.6-sol", "gpt-6-astra"])("%s: no deprecated 24h field, even when compat declares long", (id) => {
		for (const compat of [undefined, { supportsLongCacheRetention: true }]) {
			const params = completionsPayload(completionsModel(id, compat));
			expect(params.prompt_cache_retention).toBeUndefined();
			expect(params.prompt_cache_key).toBe("s1");
		}
		expect(resolveModelCapabilities(completionsModel(id)).cache.lifetimes.long).toBeUndefined();
	});
});
