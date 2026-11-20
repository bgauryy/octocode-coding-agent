import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import { getBuiltinModels } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";

interface CachePayload {
	input?: unknown[];
	prompt_cache_options?: unknown;
	prompt_cache_retention?: string;
	system?: { cache_control?: { type: string; ttl?: string } }[];
	messages?: { content: { cache_control?: { type: string; ttl?: string } }[] }[];
}

const providers = ["openai", "anthropic", "xai", "opencode", "opencode-go"] as const;
afterEach(() => vi.unstubAllGlobals());

describe.each(providers)("Catalog cache policy: %s", (provider) => {
	const models: Model<Api>[] = getBuiltinModels(provider);
	it("retains an available model catalog", () => {
		expect(models.length).toBeGreaterThan(0);
	});
	it.each(models)("builds a capability-compatible request for $id ($api)", async (model) => {
		let payload: CachePayload | undefined;
		let fetched = false;
		const rejectNetwork = async (): Promise<Response> => {
			fetched = true;
			throw new Error("Network is forbidden in catalog tests");
		};
		vi.stubGlobal("fetch", rejectNetwork);
		const result = await streamSimple(
			model,
			{
				systemPrompt: "Stable agent instructions",
				messages: [{ role: "user", content: "A changing task", timestamp: 0 }],
			},
			{
				apiKey: "sk-catalog-test",
				cacheRetention: "short",
				instructionCacheRetention: "long",
				sessionId: "catalog-cache-test",
				maxRetries: 0,
				onPayload: (value) => {
					payload = value as CachePayload;
					throw new Error("Captured catalog request");
				},
				fetch: model.api === "google-generative-ai" ? undefined : rejectNetwork,
			},
		).result();
		expect(fetched).toBe(false);
		expect(payload, result.errorMessage).toBeDefined();
		if (model.api === "openai-responses") {
			const compat = (model as Model<"openai-responses">).compat;
			const explicit = compat?.supportsExplicitPromptCacheMode === true;
			const long =
				compat?.supportsLongCacheRetention ??
				(model.provider === "openai" || new URL(model.baseUrl).hostname === "api.openai.com");
			if (explicit) {
				expect(JSON.stringify(payload?.input?.[0])).toContain(
					`"prompt_cache_breakpoint":{"mode":"explicit","ttl":"${long ? "12h" : "30m"}"}`,
				);
			} else {
				expect(JSON.stringify(payload?.input)).not.toContain("prompt_cache_breakpoint");
				expect(payload?.prompt_cache_options).toBeUndefined();
			}
			// Before GPT-5.6 the one request-level retention keeps long instructions, at no write charge.
			const extended = !explicit && compat?.supportsLongCacheRetention === true;
			expect(payload?.prompt_cache_retention).toBe(extended ? "24h" : undefined);
		} else if (model.api === "anthropic-messages") {
			const compat = (model as Model<"anthropic-messages">).compat;
			expect(payload?.system?.[0].cache_control).toEqual({
				type: "ephemeral",
				...(compat?.supportsLongCacheRetention === false ? {} : { ttl: "1h" }),
			});
			expect(payload?.messages?.[0].content[0].cache_control).toEqual({ type: "ephemeral" });
		} else {
			expect(JSON.stringify(payload)).not.toContain("prompt_cache_breakpoint");
		}
	});
});
